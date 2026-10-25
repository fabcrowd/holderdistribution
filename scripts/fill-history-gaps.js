#!/usr/bin/env node
/**
 * fill-history-gaps.js
 *
 * Gives holders-history.json a row for every day, automatically.
 *
 * The daily refresh only ever writes TODAY. If a run fails — a transient RPC
 * error, a rate limit, an Actions outage — that day is simply absent, and
 * nothing in the schedule ever goes back for it: the next run succeeds, the
 * feed reads "fresh", and the hole is permanent. That is how 2026-08-22..09-09
 * came to be missing 16 days while every staleness check stayed green, and it
 * cost a manual reconstruction to close.
 *
 * This closes it on a schedule instead. For each missing date inside the
 * reconstructable window it resolves that day's boundary block per chain, then
 * runs the ordinary pipeline scripts — `pull-holders-rpc.js --as-of=<date>`,
 * `generate-holders-lite.js`, `generate-holders-history.js` — so a filled row is
 * produced by exactly the code that produces a live one. Nothing about the
 * metrics is reimplemented here; this only decides WHICH days to run and with
 * what block boundaries.
 *
 * `cumulativeHolders` / `newHolders` depend on WHERE the gap is, because that
 * metric is a running set accumulated in holders-ever-checkpoint.json and the
 * checkpoint only ever moves forward:
 *
 *  - A TRAILING gap (the common case — the daily run failed, so the newest days
 *    are missing) is newer than the checkpoint, so the ordinary forward-only
 *    update applies and the filled row is complete. 2026-09-12, filled this
 *    way, came out with cumulativeHolders 115,680 / newHolders 21.
 *  - A MID-SERIES gap is a day the checkpoint has already passed. It cannot be
 *    derived incrementally without a seed that no longer exists, so those rows
 *    ship without the two fields (the frontend renders a non-finite value as a
 *    line break) and `pipeline-health.js` reports how many are waiting. The fix
 *    is one continuous recompute — `rebuild-holders-history.yml` — not a
 *    per-row patch. See lessons.md → "A Checkpoint Blob Is Dated by Its
 *    Content, Not by Its Commit".
 *
 * The live snapshot files are restored afterwards: an --as-of run necessarily
 * overwrites tel-holders.json / holders-summary.json / holders-lite.json with a
 * past day's state, and those are servable "current state" artifacts.
 *
 * Requires ENV_PASSPHRASE (Alchemy RPC URLs). Reconstruction anchors on the
 * holders-checkpoint.json committed before the gap, so the checkout needs full
 * history (fetch-depth: 0).
 *
 * Run: node scripts/fill-history-gaps.js [--days=14] [--dry-run]
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, rpcCall } from "./lib/rpc.js";
import { findBlockAtTime } from "./lib/historicalReplay.js";
import { selectPipelineProject, projectPaths, projectChains, projectWork } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: the project's
// data dir, its chain map and its own as-of block cache (TEL: public/data/ +
// data/; others: public/data/<slug>/ + data/<slug>/). The child scripts are
// run with the same `--project`.
const project = selectPipelineProject("fill-history-gaps", { ported: true });

await loadEnv();

const ROOT = process.cwd();
const data = projectPaths(project, ROOT);
const HISTORY_PATH = data("holders-history.json");
const BLOCKS_PATH = projectWork(project, ROOT)("holders-asof-blocks.json");
// Restored after the run — an --as-of run overwrites these with a past day.
const LIVE_ARTIFACTS = [
  data.rel("tel-holders.json"),
  data.rel("holders-summary.json"),
  data.rel("holders-lite.json"),
  data.rel("funding-wallets.json"),
];
const PROJECT_ARGS = ["--project", project.slug];

const readArg = (flag, fallback = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : fallback;
};
const DRY_RUN = process.argv.includes("--dry-run");
const WINDOW_DAYS = Number(readArg("--days", "14"));

const isoDate = (d) => d.toISOString().slice(0, 10);

const run = (script, args = []) => {
  execFileSync("node", [`scripts/${script}`, ...PROJECT_ARGS, ...args], { cwd: ROOT, stdio: "inherit" });
};

const main = async () => {
  const history = JSON.parse(await fs.readFile(HISTORY_PATH, "utf8"));
  const present = new Set(history.entries.map((e) => e.date));
  const latest = history.entries[history.entries.length - 1]?.date;
  if (!latest) throw new Error("holders-history.json has no entries");

  // Yesterday backwards FROM TODAY, not from the newest row: anchoring on the
  // newest row cannot see a trailing gap, because when the pipeline stops the
  // window slides back with the row that stopped moving. Today itself is the
  // daily refresh's job and its day boundary has not passed yet.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const missing = [];
  for (let back = 1; back <= WINDOW_DAYS; back++) {
    const day = new Date(`${todayUtc}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - back);
    const date = isoDate(day);
    if (!present.has(date)) missing.push(date);
  }
  missing.sort();

  if (missing.length === 0) {
    console.log(`No gaps in the last ${WINDOW_DAYS} days (latest row ${latest}). Nothing to do.`);
    return;
  }
  console.log(`Missing ${missing.length} date(s): ${missing.join(", ")}`);
  if (DRY_RUN) {
    console.log("--dry-run: nothing fetched or written.");
    return;
  }

  // Day-boundary blocks, cached in the repo so a re-run (or a later manual
  // reconstruction) never re-searches a date it has already resolved.
  const blocks = JSON.parse(await fs.readFile(BLOCKS_PATH, "utf8").catch(() => "{}"));
  const chainConfig = projectChains(project, ROOT);
  for (const date of missing) {
    if (blocks[date]) continue;
    blocks[date] = {};
    for (const chainKey of Object.keys(chainConfig)) {
      const rpcUrls = await getUsableRpcUrls(chainKey);
      if (!rpcUrls.length) throw new Error(`No RPC URLs for ${chainKey} — is ENV_PASSPHRASE set?`);
      const head = Number(BigInt(await rpcCall(rpcUrls[0], "eth_blockNumber", [])));
      const target = Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000);
      const getTimestamp = async (block) => {
        const b = await rpcCall(rpcUrls[0], "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
        return parseInt(b.timestamp, 16);
      };
      blocks[date][chainKey] = await findBlockAtTime(target, {
        low: Number(chainConfig[chainKey].fromBlock),
        high: head,
        getTimestamp,
      });
      console.log(`  ${date} ${chainKey}: block ${blocks[date][chainKey]}`);
    }
  }
  await fs.mkdir(path.dirname(BLOCKS_PATH), { recursive: true });
  await fs.writeFile(
    BLOCKS_PATH,
    `${JSON.stringify(Object.fromEntries(Object.keys(blocks).sort().map((k) => [k, blocks[k]])), null, 1)}\n`,
    "utf8",
  );

  const backups = new Map();
  for (const rel of LIVE_ARTIFACTS) {
    backups.set(rel, await fs.readFile(path.resolve(ROOT, rel), "utf8").catch(() => null));
  }

  try {
    for (const date of missing) {
      console.log(`\n=== ${date} ===`);
      run("pull-holders-rpc.js", [`--as-of=${date}`]);
      run("generate-holders-lite.js");
      run("generate-holders-history.js");
    }
  } finally {
    // Always restore, including on failure: leaving a past day's snapshot in
    // public/data/ would publish it as the current state on the next deploy.
    for (const [rel, content] of backups) {
      if (content !== null) await fs.writeFile(path.resolve(ROOT, rel), content, "utf8");
    }
    console.log("\nRestored live snapshot artifacts.");
  }

  const after = JSON.parse(await fs.readFile(HISTORY_PATH, "utf8"));
  const stillMissing = missing.filter((d) => !after.entries.some((e) => e.date === d));
  console.log(`Filled ${missing.length - stillMissing.length} of ${missing.length} date(s).`);
  if (stillMissing.length) {
    throw new Error(`Still missing after the run: ${stillMissing.join(", ")}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
