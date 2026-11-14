#!/usr/bin/env node
/**
 * scan-hedera-flows.js [--project <slug>] [--since YYYY-MM-DD] [--as-of YYYY-MM-DD]
 *
 * Exchange flows of a project's native Hedera coin (chains[].vm "hedera"), venue-anchored like the
 * Solana scan: every HBAR deposit to and withdrawal from the project's CEX accounts
 * (classification.cexWallets), bucketed by the repo's block-cutoff days and settled to the same
 * consensus end as the holders snapshot. Rules and the per-record classification:
 * scripts/lib/hedera/flowClassify.js, flowScan.js.
 *
 * Writes (nothing else):
 *   <data>/exchange-flow-checkpoint.json   chains.<key> = { since, setHash, accounts{id:{exchange,until}}, through,
 *                                          throughDate, throughBlock, dayEnds{date:{stamp,block}}, complete, failed? }
 *   <work>/hedera-flow-days.json           exact per-day / per-counterparty tinybar sums (not served)
 *   <data>/date-blocks.json                day cutoffs it had to resolve
 * scan-exchange-flows.js and generate-tier-outflows.js publish the feeds from that store, so run this first.
 *
 * setHash = hash of the sorted (account id, exchange) set plus the classifier version. When it differs from the
 * stored one (account added, removed, relabeled; classifier changed), this chain's cursors and day rows are
 * discarded and rebuilt from the floor under the same budget, so the store always equals a fresh scan of the
 * current set. Reordering the accounts alone changes nothing.
 *
 * Target day: --as-of | yesterday UTC (never earlier than a day already scanned). Floor: --since |
 * HEDERA_FLOWS_SINCE | the first committed holder snapshot date (forward-only history, owner decision 2026-11-11).
 * Budget: HEDERA_FLOW_MAX_MS (default 40 min wall clock, under the nightly step's 45-minute timeout): stops
 * cleanly before the next page, saves, and the next run resumes. A page that still fails after the client's
 * retries keeps that account's cursor, marks the scan incomplete (the feeds then stamp no day) and exits 1.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectPaths, projectWork } from "./lib/projects.js";
import { resolveSettledDate } from "./lib/asOf.js";
import { loadChainAdapter } from "./lib/chainAdapters.js";

await loadEnv();
const project = selectPipelineProject("scan-hedera-flows", { ported: true });
const adapter = await loadChainAdapter("hedera");
const kit = await adapter.flows();
const chains = kit.hederaFlowChains(project.config);
if (chains.length === 0) {
  console.log(`${project.slug}: no Hedera chain; nothing to do.`);
  process.exit(0);
}
if (chains.length > 1) throw new Error(`${project.slug}: ${chains.length} Hedera chains; the flow scan supports one native coin per project`);
const [{ chain, key, decimals }] = chains;

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const data = projectPaths(project);
const work = projectWork(project);
const CHECKPOINT_PATH = data("exchange-flow-checkpoint.json");
const STORE_PATH = work("hedera-flow-days.json");
const day = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? "");
const dayBefore = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const readOptionalJson = async (p) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
// A half-written JSON file would make the next run discard the cursors or the store.
const writeJsonAtomic = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
};

let since = argValue("--since") ?? (process.env.HEDERA_FLOWS_SINCE || null);
if (!since) {
  const { firstSnapshotDate } = await import("./lib/solana/flowConfig.js");
  since = firstSnapshotDate(data.rel("tel-holders.json"));
}
if (!day(since)) {
  console.error(`${project.slug}: no flow floor (no committed holder snapshot; pass --since YYYY-MM-DD).`);
  process.exit(1);
}
const accounts = kit.hederaFlowAccounts(project);
if (accounts.length === 0) {
  console.log(`${project.slug}: no exchange accounts in classification.cexWallets; nothing to scan.`);
  process.exit(0);
}

const checkpoint = (await readOptionalJson(CHECKPOINT_PATH)) ?? { chains: {} };
checkpoint.chains ??= {};
const { applyFlowEventsOnce } = await import("./lib/solana/flowFeeds.js");
// The stored flows must equal a fresh scan of the CURRENT inputs: a missing store, another floor, another
// exchange account set (ids or labels) or classifier version rebuilds this chain from `since`.
const plan = kit.planFlowResume({ prev: checkpoint.chains[key] ?? null, store: (await readOptionalJson(STORE_PATH)) ?? null, since, accounts, key });
let { store } = plan;
const { prev, setHash } = plan;
const staleDayEnds = checkpoint.chains[key]?.dayEnds ?? {};
if (plan.reason) console.warn(`  ${key}: rebuilding the flow scan from ${since} because ${plan.reason}; cursors reset and ${key} day rows cleared.`);

const requested = resolveSettledDate({ asOf: argValue("--as-of") ?? null });
const targetDate = prev?.throughDate && prev.throughDate > requested ? prev.throughDate : requested;
if (dayBefore(since) > targetDate) {
  console.error(`${project.slug}: floor ${since} is after the settled day ${targetDate}; nothing to scan yet.`);
  process.exit(0);
}

const deadlineMs = Date.now() + (Number(process.env.HEDERA_FLOW_MAX_MS) || 40 * 60 * 1000);
const { client, requests } = kit.countRequests(adapter.mirrorClient(chain));
const clock = adapter.clock(chain, { client });
const startedAt = Date.now();

const { ends, startStamp } = await kit.resolveDayEnds(project, { key, clock, firstDate: since, lastDate: targetDate, known: prev?.dayEnds ?? staleDayEnds });
const through = ends[targetDate].stamp;
const dayEnds = Object.entries(ends).filter(([d]) => d >= since).map(([date, e]) => ({ date, stamp: e.stamp }));
console.log(`  ${key}: ${accounts.length} exchange accounts; floor ${since}, through ${targetDate} (block ${ends[targetDate].block}, consensus ${through})`);

let state = {
  since,
  setHash,
  accounts: Object.fromEntries(accounts.map((a) => [a.id, { exchange: a.exchange, until: prev?.accounts?.[a.id]?.until ?? startStamp }])),
  through,
  throughDate: targetDate,
  throughBlock: ends[targetDate].block,
  dayEnds: ends,
  complete: false,
};
const behind = () => accounts.filter((a) => kit.nanosOf(state.accounts[a.id].until) < kit.nanosOf(through)).map((a) => a.id);
const persist = async () => {
  // Store first: a crash in between re-delivers the page, which applyFlowEventsOnce drops.
  await writeJsonAtomic(STORE_PATH, store);
  await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
};
const save = async ({ newEvents, cursors }) => {
  applyFlowEventsOnce(store, key, newEvents);
  state = { ...state, accounts: Object.fromEntries(accounts.map((a) => [a.id, { exchange: a.exchange, until: cursors[a.id].until }])) };
  checkpoint.chains[key] = { ...state, lastBlock: state.throughBlock, complete: false };
  await persist();
};

const res = await kit.scanHederaFlows({ client, accounts, cursors: state.accounts, start: startStamp, through, dayEnds, deadlineMs, onProgress: save });
state = { ...state, accounts: Object.fromEntries(accounts.map((a) => [a.id, { exchange: a.exchange, until: res.cursors[a.id].until }])) };
const left = behind();
const final = { ...state, lastBlock: state.throughBlock, complete: left.length === 0 && res.failed.length === 0 };
if (res.failed.length) final.failed = res.failed;
checkpoint.chains[key] = final;
await persist();

const s = res.stats;
console.log(
  `  ${key}: ${s.transactions} records read (${s.owned} counted: ${s.failedTransactions} failed, ${s.childTransactions} child, ${s.scheduledTransactions} scheduled, ${s.internalEvents} internal), ` +
    `${res.events.length} events, ${s.pages} pages (${s.emptyContinuationPages} empty continuations), ${requests()} mirror requests, ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
);
if (s.feeUnmatched || s.nonSuccessWithFlow) console.warn(`  ${key}: ${s.feeUnmatched} records whose fee legs did not match charged_tx_fee, ${s.nonSuccessWithFlow} unsuccessful records with a flow; check them`);
if (s.rewardPoolFeeShareRecords) console.log(`  ${key}: ${s.rewardPoolFeeShareRecords} reward records also carried a 0.0.800 fee share (added back to the reward)`);
if (s.rewardRecords) console.log(`  ${key}: ${s.rewardRecords} records carried a staking reward (excluded; ${s.rewardResidualTinybar} tinybar unpaired residual)`);
if (res.timedOut) console.log(`  ${key}: stopped at the time budget (HEDERA_FLOW_MAX_MS); ${left.length} accounts behind, resumes next run`);
console.log(`Wrote ${STORE_PATH} and ${CHECKPOINT_PATH}${final.complete ? ` (complete through ${targetDate})` : " (incomplete)"}`);
if (res.failed.length) {
  console.error(`  ${key}: ${res.failed.length} account scans failed after retries; the feeds stamp no day until they catch up`);
  process.exit(1);
}
