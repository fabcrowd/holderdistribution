#!/usr/bin/env node
/**
 * scan-solana-flows.js [--project <slug>] [--since YYYY-MM-DD] [--max-tx N]
 *
 * Venue-anchored token flows for a project's Solana chains (chains[].vm
 * "solana"; mint and decimals from config/projects/<slug>.json). Tracked
 * venues: classification.cexWallets, contracts{} role dex, optional
 * classification.dexContracts. See scripts/lib/solana/flowScan.js for the
 * discovery / resume rules.
 *
 * Writes (nothing else):
 *   <data>/exchange-flow-checkpoint.json   chains.<key> = { mint, since, accounts{ata:{owner,until}}, complete, missingTx }
 *   <work>/solana-flow-days.json           exact per-day / per-counterparty raw sums (not served)
 * scan-exchange-flows.js and generate-tier-outflows.js publish the feeds from
 * that store, so run this first.
 *
 * Floor: --since | SOLANA_FLOWS_SINCE | the first committed holder snapshot
 * date (never earlier: no tier / no real data before it).
 * Budget: --max-tx | SOLANA_FLOW_MAX_TX (default 15000 transactions per run, about a day of ZBCN venue activity;
 * the rest is picked up by the next run), SOLANA_FLOW_MAX_MS (default 20 min
 * wall clock; stops cleanly after the current chunk). SOLANA_FLOW_CONCURRENCY
 * (default 4). Progress is saved after every chunk of transactions.
 * RPC: chain "solana" reads SOLANA_RPC_0..9; this scan tries keyed endpoints
 * first and the public one last (it makes thousands of calls).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectPaths, projectWork } from "./lib/projects.js";

await loadEnv();
const project = selectPipelineProject("scan-solana-flows", { ported: true });
const { solanaFlowChains, solanaFlowVenues, firstSnapshotDate } = await import("./lib/solana/flowConfig.js");
const chains = solanaFlowChains(project.config);
if (chains.length === 0) {
  console.log(`${project.slug}: no Solana chain; nothing to do.`);
  process.exit(0);
}

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const data = projectPaths(project);
const work = projectWork(project);
const CHECKPOINT_PATH = data("exchange-flow-checkpoint.json");
const STORE_PATH = work("solana-flow-days.json");
const STAKING_FEED = data("solana-staking.json");

const readOptionalJson = async (p) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

const since = argValue("--since") ?? (process.env.SOLANA_FLOWS_SINCE || firstSnapshotDate(data.rel("tel-holders.json")));
if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? "")) {
  console.error(`${project.slug}: no flow floor (no committed holder snapshot; pass --since YYYY-MM-DD).`);
  process.exit(1);
}
const sinceSec = Date.parse(`${since}T00:00:00Z`) / 1000;
const maxTx = Number(argValue("--max-tx") || process.env.SOLANA_FLOW_MAX_TX) || 15000;
const concurrency = Number(process.env.SOLANA_FLOW_CONCURRENCY) || 4;

const { configureSolanaChain, getUsableSolanaRpcUrls, keyedFirst, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
const { scanVenueFlows } = await import("./lib/solana/flowScan.js");
const { applyFlowEventsOnce, emptyFlowStore } = await import("./lib/solana/flowFeeds.js");

// Stop cleanly before the workflow step's 25-minute timeout so progress is kept.
const deadlineMs = Date.now() + (Number(process.env.SOLANA_FLOW_MAX_MS) || 20 * 60 * 1000);

// A half-written JSON file would make the next run discard the cursors or the store.
const writeJsonAtomic = async (file, value) => {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
};

const persist = async () => {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
  // Store first: a crash in between re-delivers the chunk, which applyFlowEventsOnce skips.
  await writeJsonAtomic(STORE_PATH, store);
  await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
};

const checkpoint = (await readOptionalJson(CHECKPOINT_PATH)) ?? { chains: {} };
checkpoint.chains ??= {};
let store = (await readOptionalJson(STORE_PATH)) ?? null;
if (!store) {
  // A cursor without its day store would silently drop everything before it.
  if (chains.some((c) => checkpoint.chains[c.key]?.accounts)) {
    console.warn(`  ${STORE_PATH} missing but a checkpoint exists: discarding the Solana cursors and re-scanning from ${since}.`);
    for (const c of chains) delete checkpoint.chains[c.key];
  }
  store = emptyFlowStore();
}

for (const c of chains) {
  if (Date.now() >= deadlineMs) {
    console.log(`  ${c.key}: time budget used up before scanning; checkpoint unchanged`);
    continue;
  }
  const prev = checkpoint.chains[c.key];
  if (prev && (prev.mint !== c.mint || prev.since !== since)) {
    console.warn(`  ${c.key}: mint or floor changed (${prev.mint}@${prev.since} -> ${c.mint}@${since}); re-scanning from the floor.`);
    delete checkpoint.chains[c.key];
    delete store.chains[c.key];
  }
  configureSolanaChain(c.chain);
  // Flow scans make thousands of calls; keyed endpoints first, public last.
  const urls = keyedFirst(await getUsableSolanaRpcUrls(c.key), c.key);
  const call = (m, p) => solanaCallWithFailover(urls, m, p, { chainKey: c.key });
  const venues = solanaFlowVenues(project, c.key, { stakingFeedPath: STAKING_FEED });
  console.log(`  ${c.key}: ${venues.cexWallets.length} CEX, ${venues.dexOwners.length} DEX, ${venues.stakingAddresses.length} staking addresses; floor ${since}, budget ${maxTx} tx`);
  const baseMissing = checkpoint.chains[c.key]?.missingTx ?? 0;
  // Saved after every chunk: a crash, 429 storm or the deadline keeps all
  // progress made so far (the old end-of-run write lost a whole 25-minute run).
  const save = async ({ newEvents, accounts, remaining, missing }) => {
    applyFlowEventsOnce(store, c.key, newEvents);
    checkpoint.chains[c.key] = { mint: c.mint, since, accounts, complete: remaining === 0, missingTx: baseMissing + missing };
    await persist();
  };
  const res = await scanVenueFlows({
    call, mint: c.mint, ...venues, state: checkpoint.chains[c.key], sinceSec, maxTx, concurrency, deadlineMs, onProgress: save,
  });
  await save({ newEvents: [], accounts: res.accounts, remaining: res.remaining, missing: res.missing });
  console.log(`  ${c.key}: ${res.processed} tx processed, ${res.events.length} events, ${res.remaining} signatures left, ${res.missing} unavailable${res.timedOut ? " (stopped at the time budget; resumes next run)" : ""}`);
}

await persist();
console.log(`Wrote ${STORE_PATH} and ${CHECKPOINT_PATH}`);
