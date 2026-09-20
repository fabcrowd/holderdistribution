#!/usr/bin/env node
/**
 * pipeline-health.js
 *
 * Standing health check for the data pipeline, designed to be run from OUTSIDE
 * GitHub Actions — by a human, or by a Claude Code session on a schedule.
 *
 * WHY THIS CANNOT LIVE INSIDE A GITHUB ACTIONS WORKFLOW
 *
 * The failure mode that actually happened (2026-08-29) was an account-level
 * Actions block: every workflow failed in 3-5 seconds with no job logs,
 * INCLUDING workflows that touch no chain data. A watchdog workflow added to
 * this same repo would be blocked by the same gate it exists to detect — it
 * would never run either. Detection has to live somewhere Actions being down
 * cannot silence, which means outside Actions entirely. This script is built
 * to be that: it only reads files already in the repo (via `git pull`) or
 * already served (via HTTPS), needs no RPC credentials, and takes under a
 * second.
 *
 * WHAT "healthy" MEANS
 *
 * Ground truth is DATA FRESHNESS, not workflow run status. A workflow can
 * succeed and still write stale or wrong data (see check-feed-consistency.js);
 * a workflow can fail for a reason that doesn't matter (a transient RPC
 * timeout the next scheduled run absorbs). Checking `generatedAt` against a
 * per-feed threshold answers the only question that matters to a reader of
 * the site: is what's on screen current.
 *
 * Thresholds are wider than the cron period so a single missed run doesn't
 * page. `refresh-tel-holders` runs daily → 36h. `scan-exchange-flows` and
 * `generate-tier-outflows` are chained after it via workflow_run, and
 * tier-outflows in particular is allowed to run behind during a legitimate
 * incremental backfill (see generate-tier-outflows.js's own `complete` flag),
 * so it gets a 4-day allowance rather than paging on ordinary catch-up lag.
 * `sync-cex-wallets` is biweekly → 20 days.
 *
 * OUTPUT CONTRACT
 *
 * Exit 0 = healthy. Exit 1 = at least one feed exceeded its threshold, and the
 * printed report includes the EXACT next commands to run locally — see
 * README → "When the scheduled workflows are down". This is deliberate: the
 * output of this script is written to be pasted directly into a Claude Code
 * session as the instruction for what to do next, since that is the actual
 * delivery path (see "note to run it in this environment" in README).
 *
 * Run: node scripts/pipeline-health.js [--json]
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const DATA = path.resolve(ROOT, "public/data");
const asJson = process.argv.includes("--json");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * One entry per feed this pipeline is responsible for. `thresholdMs` is
 * deliberately wider than the cron period — see file header. `fallback` is the
 * exact local command sequence to run when this feed trips, credential
 * requirement stated up front so a session with only ENV_PASSPHRASE (no
 * ETHERSCAN_API_KEY) can immediately see what it can and can't do.
 */
const FEEDS = [
  {
    file: "holders-lite.json",
    label: "Holder snapshot (retail/CEX/staking)",
    thresholdMs: 36 * HOUR,
    workflow: "Refresh TEL holders snapshot",
    fallback: [
      "Needs ENV_PASSPHRASE + ETHERSCAN_API_KEY (full chain rescan).",
      "export ENV_PASSPHRASE=... ETHERSCAN_API_KEY=...",
      "node scripts/pull-staker-balances.js",
      "node scripts/pull-holders-rpc.js",
      "node scripts/pull-cex-wallets.js",
      "node scripts/generate-holders-lite.js",
      "node scripts/generate-holders-history.js",
      "node scripts/generate-holder-transitions.js",
      "node scripts/reconcile-supply.js",
      "node scripts/append-treasury-history.js",
      "node scripts/sync-classification-changelog.js",
      "npm run check:feeds",
    ],
  },
  {
    file: "exchange-flow-history.json",
    label: "Exchange deposit/withdrawal flows",
    thresholdMs: 48 * HOUR,
    workflow: "Scan exchange flows",
    fallback: [
      "Needs ENV_PASSPHRASE only (uncapped alchemy_getAssetTransfers path, not the",
      "10-block-capped eth_getLogs scanner — see extend-transfer-caches.js header).",
      "export ENV_PASSPHRASE=...",
      "node scripts/extend-transfer-caches.js",
      "node scripts/append-exchange-flows-from-cache.js",
      "npm run check:feeds",
    ],
  },
  {
    file: "tier-outflows.json",
    label: "Tier-level outflow attribution",
    thresholdMs: 4 * DAY,
    workflow: "Generate tier outflows",
    fallback: [
      "NO local fallback exists. generate-tier-outflows.js's dexSwap/dexLp split",
      "needs an eth_getTransactionReceipt per DEX tx; the cached transfer files",
      "carry no tx hash (normalizeTransfer drops it). This can only be closed by",
      "the real workflow running — i.e. by clearing the Actions block, not by",
      "running anything in this environment. Flag this to the user directly.",
    ],
  },
  {
    file: "funding-wallets.json",
    label: "Staker balances (staking attribution)",
    // Wider than the others on purpose: pull-staker-balances.js is now
    // non-fatal in both workflows (see refresh-tel-holders.yml), so a day or
    // two of quota exhaustion costs freshness here instead of costing the
    // whole holders feed. That trade is only safe if the staleness is VISIBLE,
    // which is what this entry is for — without it, stale staking attribution
    // would be silently folded into every holder balance with nothing
    // reporting it.
    thresholdMs: 3 * DAY,
    workflow: "Refresh TEL holders snapshot",
    fallback: [
      "Needs ETHERSCAN_API_KEY + ENV_PASSPHRASE.",
      "export ENV_PASSPHRASE=... ETHERSCAN_API_KEY=...",
      "node scripts/pull-staker-balances.js",
      "Then re-run the holders chain so the attribution lands in the snapshot:",
      "node scripts/pull-holders-rpc.js && node scripts/generate-holders-lite.js",
      "node scripts/generate-holders-history.js",
      "If this fails with 'Monthly capacity limit exceeded', it is the Alchemy",
      "account quota, not a script bug — no local fallback exists.",
    ],
  },
  {
    file: "cex-wallets.json",
    label: "CEX wallet list (Dune sync)",
    thresholdMs: 20 * DAY,
    workflow: "Sync CEX wallets from Dune",
    fallback: [
      "Needs the DUNE_API_KEY secret, which this environment does not have.",
      "No local fallback — flag to the user; this one is genuinely low urgency",
      `(${20} day threshold, biweekly cron).`,
    ],
  },
];

const readJson = async (rel) => {
  try {
    return JSON.parse(await fs.readFile(path.resolve(DATA, rel), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/**
 * Freshness is not completeness. A day the pipeline never ran for leaves a hole
 * that no staleness check can see: the next run lands, every feed reads fresh,
 * and the missing date is permanent. That is exactly how 2026-08-22..09-09 lost
 * 16 days while all four feeds stayed green. fill-history-gaps.js closes holes
 * on a schedule; this reports any it has not closed yet, plus the rows waiting
 * on a continuous recompute for their cumulativeHolders.
 */
const checkHistoryGaps = async (windowDays = 30) => {
  const history = await readJson("holders-history.json");
  const entries = history?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const present = new Set(entries.map((e) => e.date));
  const latest = entries[entries.length - 1].date;
  // Anchored on TODAY, not on the latest row. Anchoring on the latest row
  // cannot see a TRAILING gap — if the pipeline stops entirely, the newest row
  // stays put and the window slides back with it, so the days since simply are
  // not looked at and coverage reads clean while nothing is landing. That is
  // the exact failure in play when the Alchemy quota runs out.
  const today = new Date();
  const missing = [];
  for (let back = 1; back <= windowDays; back++) {
    const day = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - back);
    const date = day.toISOString().slice(0, 10);
    if (!present.has(date)) missing.push(date);
  }
  const windowStart = new Date(`${latest}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
  const withoutCumulative = entries.filter(
    (e) => e.date >= windowStart.toISOString().slice(0, 10) && typeof e.cumulativeHolders !== "number",
  );
  return { latest, windowDays, missing: missing.sort(), withoutCumulative: withoutCumulative.map((e) => e.date) };
};

const main = async () => {
  const now = Date.now();
  const results = [];

  for (const feed of FEEDS) {
    const doc = await readJson(feed.file);
    if (!doc) {
      results.push({ ...feed, status: "missing", ageMs: null });
      continue;
    }
    const generatedAt = Date.parse(doc.generatedAt ?? "");
    if (!Number.isFinite(generatedAt)) {
      results.push({ ...feed, status: "no-timestamp", ageMs: null });
      continue;
    }
    const ageMs = now - generatedAt;
    results.push({ ...feed, status: ageMs > feed.thresholdMs ? "stale" : "healthy", ageMs });
  }

  const unhealthy = results.filter((r) => r.status !== "healthy");
  const gaps = await checkHistoryGaps();

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date(now).toISOString(), results, gaps, healthy: unhealthy.length === 0 }, null, 2));
    process.exit(unhealthy.length === 0 ? 0 : 1);
  }

  console.log(`Pipeline health check — ${new Date(now).toISOString()}\n`);
  for (const r of results) {
    const ageStr = r.ageMs != null ? `${(r.ageMs / HOUR).toFixed(1)}h old (limit ${(r.thresholdMs / HOUR).toFixed(0)}h)` : "";
    const mark = r.status === "healthy" ? "ok  " : r.status === "stale" ? "STALE" : r.status.toUpperCase();
    console.log(`  ${mark.padEnd(6)} ${r.label.padEnd(38)} ${ageStr}`);
  }

  if (gaps) {
    const mark = gaps.missing.length === 0 ? "ok  " : "GAP";
    console.log(
      `  ${mark.padEnd(6)} ${`Daily coverage (last ${gaps.windowDays}d)`.padEnd(38)} ` +
        `${gaps.missing.length} missing date(s)`,
    );
    if (gaps.missing.length) {
      console.log(`         missing: ${gaps.missing.join(", ")}`);
      console.log('         fix: node scripts/fill-history-gaps.js   (workflow: "Fill holders-history gaps")');
    }
    if (gaps.withoutCumulative.length) {
      console.log(
        `         ${gaps.withoutCumulative.length} row(s) await a continuous recompute for ` +
          `cumulativeHolders (workflow: "Rebuild holders history from Transfer logs")`,
      );
    }
  }

  if (unhealthy.length === 0) {
    console.log("\nAll feeds within threshold. Nothing to do.");
    process.exit(0);
  }

  console.log(`\n${unhealthy.length} feed(s) exceeded their freshness threshold.`);
  console.log("This means the scheduled GitHub Actions workflows are not landing — check");
  console.log("Actions → recent runs for the workflow(s) named below. If runs are failing in");
  console.log("3-5 seconds with no logs across UNRELATED workflows too, that is an");
  console.log("account-level block (billing/spending limit), not a script bug — tell the user");
  console.log("directly rather than debugging the scripts.\n");
  console.log("Run the fallback for each stale feed, IN THIS ENVIRONMENT, in this order:\n");

  for (const r of unhealthy) {
    console.log(`--- ${r.label} (workflow: "${r.workflow}") ---`);
    for (const line of r.fallback) console.log(`  ${line}`);
    console.log();
  }

  console.log("After running any fallback: git add the changed public/data/**, commit, and");
  console.log("push straight to main (per CLAUDE.md — no PR needed). Netlify deploys on push.");

  process.exit(1);
};

await main();
