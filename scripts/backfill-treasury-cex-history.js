#!/usr/bin/env node
/**
 * backfill-treasury-cex-history.js
 *
 * append-treasury-history.js and pull-cex-wallets.js only ever write TODAY, so a
 * day their run missed stays absent from treasury-history.json /
 * cex-balance-history.json. This reconstructs those days from Transfer logs,
 * anchored on the nearest existing row (method and limits: see
 * lib/treasuryCexBackfill.js).
 *
 *  - DRY RUN BY DEFAULT: reconstructs and prints rows; writes nothing.
 *  - Never overwrites an existing date; rows get `backfilled: true`.
 *  - Needs RPC (ENV_PASSPHRASE-decrypted keys); refuses without it, even in dry run.
 *  - Treasury anchors are the nearest row that agrees with a real neighbour (a
 *    snapshot missing a known wallet is skipped); rows before a
 *    `treasury.labelEras[].before` date are replayed with that era's labels.
 *  - --write is refused when the replay disagrees with the next real row by more
 *    than --max-drift-pct (default 2) unless --allow-drift.
 *
 * Usage: node scripts/backfill-treasury-cex-history.js --project tel --from 2026-10-03 --to 2026-10-22 [--write]
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, rpcCall } from "./lib/rpc.js";
import { findBlockAtTime } from "./lib/historicalReplay.js";
import { fetchAllTransfers } from "./lib/alchemyTransfers.js";
import { resolveChainTokens } from "./lib/telTokens.js";
import {
  selectPipelineProject,
  projectPaths,
  projectWork,
  projectChains,
  projectClassificationPath,
} from "./lib/projects.js";
import {
  categoryAddressMap,
  exchangeAddressMap,
  mergeBackfilledEntries,
  reconstructHistory,
  worstDrift,
} from "./lib/treasuryCexBackfill.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readArg = (flag, fallback = null) => {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const readJson = async (p, fallback = undefined) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** Live RPC client; the only place this script touches the network. */
const createLiveClient = (chainConfig) => ({
  async blockAtEndOfDate(chainKey, date) {
    const [rpcUrl] = await getUsableRpcUrls(chainKey);
    if (!rpcUrl) throw new Error(`No RPC URL for ${chainKey}`);
    const head = Number(BigInt(await rpcCall(rpcUrl, "eth_blockNumber", [])));
    const target = Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000);
    const getTimestamp = async (block) => {
      const b = await rpcCall(rpcUrl, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
      return parseInt(b.timestamp, 16);
    };
    return findBlockAtTime(target, { low: Number(chainConfig[chainKey].fromBlock), high: head, getTimestamp });
  },
  async fetchTransfers({ chainKey, tokenAddress, fromBlock, toBlock }) {
    const [rpcUrl] = await getUsableRpcUrls(chainKey);
    if (!rpcUrl) throw new Error(`No RPC URL for ${chainKey}`);
    return fetchAllTransfers(rpcUrl, { fromBlock, toBlock, contractAddress: tokenAddress });
  },
});

const pct = (x) => `${(x * 100).toFixed(3)}%`;

const main = async () => {
  const project = selectPipelineProject("backfill-treasury-cex-history", { ported: true });
  const from = readArg("--from");
  const to = readArg("--to");
  if (!from || !to) fail("Usage: --project <slug> --from YYYY-MM-DD --to YYYY-MM-DD [--write]");
  const write = process.argv.includes("--write");
  const allowDrift = process.argv.includes("--allow-drift");
  const maxDrift = Number(readArg("--max-drift-pct", "2")) / 100;
  if (!Number.isFinite(maxDrift) || maxDrift < 0) fail("--max-drift-pct must be a non-negative number");
  if (to >= new Date().toISOString().slice(0, 10)) fail(`--to ${to} must be before today (UTC): the day is not over yet.`);

  if (!process.env.ENV_PASSPHRASE) fail("ENV_PASSPHRASE is not set: refusing to run without decrypted RPC keys.");
  await loadEnv();

  const data = projectPaths(project, ROOT);
  const treasuryPath = data("treasury-history.json");
  const cexPath = data("cex-balance-history.json");
  const blocksPath = projectWork(project, ROOT)("holders-asof-blocks.json");

  const categories = project.config?.treasury?.categories ?? ["treasury", "council", "holdings", "escrow"];
  const exclusionsPath = projectClassificationPath(project, "exclusions", ROOT);
  const cexWalletsPath = projectClassificationPath(project, "cexWallets", ROOT);
  const categoryByAddress = categoryAddressMap(exclusionsPath ? await readJson(exclusionsPath) : {}, categories);
  const exchangeByAddress = exchangeAddressMap(cexWalletsPath ? await readJson(cexWalletsPath) : {});
  if (!categoryByAddress.size && !exchangeByAddress.size) fail(`project "${project.slug}" declares no treasury or CEX addresses.`);

  const chainConfig = projectChains(project, ROOT);
  const hasUpgrade = Boolean(project.config?.supply?.upgrade);
  const chains = Object.entries(chainConfig).map(([key, cfg]) => {
    const t = resolveChainTokens({ ...cfg, key });
    return {
      key,
      tokens: [
        { ...t.legacy, generation: "legacy" },
        ...(t.v3 ? [{ ...t.v3, generation: "v3" }] : []),
      ],
      upgradeContracts: hasUpgrade ? t.escrow : [],
    };
  });

  const treasuryHistory = await readJson(treasuryPath, { entries: [] });
  const cexHistory = await readJson(cexPath, { entries: [] });
  const blockCache = await readJson(blocksPath, {});

  console.log(`${write ? "WRITE" : "DRY RUN"} ${project.slug} ${from}..${to}`);
  const result = await reconstructHistory({
    treasuryHistory,
    cexHistory,
    from,
    to,
    categories,
    categoryByAddress,
    categoryEras: project.config?.treasury?.labelEras ?? [],
    exchangeByAddress,
    chains,
    blockCache,
    client: createLiveClient(chainConfig),
    log: console.log,
  });

  for (const s of result.skipped) console.warn(`skipped ${s.kind} ${s.date}: ${s.reason}`);
  for (const r of result.treasuryRows) console.log(`treasury ${r.date} ${JSON.stringify(r.categories)}`);
  for (const r of result.cexRows) console.log(`cex ${r.date} total ${r.total}`);
  if (!result.treasuryRows.length && !result.cexRows.length) {
    console.log("Nothing to backfill.");
    return;
  }

  const t = result.drift.treasury;
  if (t) for (const [k, v] of Object.entries(t.byCategory)) console.log(`drift vs ${t.date} treasury.${k}: ${pct(v.drift)}`);
  if (result.drift.cex) console.log(`drift vs ${result.drift.cex.date} cex total: ${pct(result.drift.cex.total.drift)}`);
  const worst = worstDrift(result.drift);
  const validated = Boolean(t || result.drift.cex);
  if (!validated) console.warn("WARNING: no later existing row to validate against; reconstruction is unverified.");
  if (worst > maxDrift && !allowDrift) {
    fail(`Worst drift ${pct(worst)} exceeds ${pct(maxDrift)}: refusing${write ? " to write" : ""}. Re-run with --allow-drift to override.`);
  }

  if (!write) {
    console.log("Dry run: nothing written. Re-run with --write.");
    return;
  }

  // Re-read right before writing so a concurrent run's rows are never clobbered.
  const files = [
    [treasuryPath, result.treasuryRows],
    [cexPath, result.cexRows],
  ];
  for (const [file, rows] of files) {
    if (!rows.length) continue;
    const current = await readJson(file, { entries: [] });
    const { entries, added, skipped } = mergeBackfilledEntries(current.entries, rows);
    if (skipped.length) console.warn(`${file}: left existing ${skipped.join(", ")} untouched`);
    await fs.writeFile(file, `${JSON.stringify({ ...current, entries }, null, 2)}\n`, "utf8");
    console.log(`Wrote ${file}: +${added.length} rows`);
  }
  if (Object.keys(result.resolvedBlocks).length) {
    const merged = { ...blockCache };
    for (const [date, perChain] of Object.entries(result.resolvedBlocks)) merged[date] = { ...perChain, ...merged[date] };
    const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
    await fs.mkdir(path.dirname(blocksPath), { recursive: true });
    await fs.writeFile(blocksPath, `${JSON.stringify(sorted, null, 1)}\n`, "utf8");
    console.log(`Cached new boundary blocks in ${blocksPath}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
