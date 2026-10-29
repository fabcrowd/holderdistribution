#!/usr/bin/env node
/**
 * rebuild-holders-history-solana.js [--project <slug>] [--since YYYY-MM-DD]
 *                                   [--max-tx N] [--write] [--allow-public]
 *
 * Replays a Solana SPL token's transaction history into holders-history
 * entries for a project whose Solana chain declares the token
 * (config/projects/<slug>.json chains[].tokens[]). Opt-in: nothing schedules it.
 * Solana counterpart of rebuild-history-from-logs.js (EVM-only).
 *
 * How it works
 *  - Discovery: one getProgramAccounts(mint) call lists the token accounts,
 *    zero-balance ones included (they still carry history). Non-retail owners
 *    (exclusions, CEX, DEX) are skipped: their transfers reach the retail
 *    ledger through the retail side, so the replay stays exact and the heaviest
 *    CEX histories are never listed.
 *  - Each tracked account's signatures are listed (getSignaturesForAddress,
 *    cursor = newest signature already processed), merged, and processed
 *    OLDEST FIRST, at most --max-tx per run, whole slots only.
 *  - Each transaction goes through getTransaction (jsonParsed) and
 *    mintDeltasByOwner; scripts/lib/solana/holderReplay.js snapshots every UTC
 *    day at its end and derives holderCount / newHolders / cumulativeHolders.
 *  - The checkpoint (data/<slug>/holders-replay-solana.checkpoint.json) holds the
 *    ledger, the per-account cursors and the emitted entries, so runs resume.
 *
 * Writes
 *  - Always: the checkpoint in data/<slug>/ (non-public, gitignored from
 *    artifacts; the workflow commits it only on a real run).
 *  - --write, and only once the replay has caught up with the chain tip:
 *    public/data/<slug>/holders-history.json (replayed dates replaced, other
 *    rows kept) and public/data/<slug>/holders-ever-checkpoint.json.
 *
 * Limits (read before trusting a number)
 *  - --since trims the published range only. Balances need the full history
 *    from the mint's first transaction, so it does not cut RPC cost.
 *  - Token accounts closed before the run are not discovered, so their
 *    historical balance is missing from earlier days. The reconciliation line
 *    at the end counts owners whose replayed balance differs from the
 *    on-chain sum at discovery.
 *  - Balances held inside staking programs (stake vaults, PDAs) are not holder
 *    balances here, so holderCount counts wallet-held token only. The live
 *    pipeline's stakingV3Balance is carried over for replayed dates.
 *
 * Cost: printed before the replay starts, from a sample of retail owners.
 *
 * Env: SOLANA_RPC_0..9 (public endpoint first), SOLANA_FLOW_CONCURRENCY
 * (default 4), SOLANA_HOLDERS_REPLAY_MAX_TX (default 50000, overridden by --max-tx),
 * SOLANA_HOLDERS_REPLAY_RPS (assumed request rate for the time estimate, default 10).
 */
import fs from "node:fs/promises";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectPaths, projectWork, projectNonRetailPaths } from "./lib/projects.js";
import { projectHolderTiers } from "./lib/holderTiers.js";
import { setHolderTiers } from "./lib/holdersView.js";
import { loadNonRetailSet } from "./lib/nonRetailSet.js";
import { solanaFlowChains } from "./lib/solana/flowConfig.js";
import { solanaBaseToken } from "./lib/solana/adapter.js";
import { PROGRAM_BY_NAME } from "./lib/solana/metadata.js";
import { holderScanParams } from "./lib/solana/splScanner.js";
import { listSignatures, bySlotThenSig, mapLimit } from "./lib/solana/flowScan.js";
import { mintDeltasByOwner } from "./lib/solana/tokenFlows.js";
import {
  cexBalanceAsOf,
  createReplayState,
  estimateReplayCost,
  finalizeReplay,
  mergeHistoryEntries,
  replayTransactions,
  restoreReplayState,
  serializeReplayState,
  takeWholeSlots,
  trackedTokenAccounts,
} from "./lib/solana/holderReplay.js";

await loadEnv();
const project = selectPipelineProject("rebuild-holders-history-solana", { ported: true });
const chains = solanaFlowChains(project.config);
if (chains.length === 0) {
  console.log(`${project.slug}: no Solana chain; nothing to replay.`);
  process.exit(0);
}
if (chains.length > 1) {
  console.error(`${project.slug}: ${chains.length} Solana chains declared; this replay handles one token per run.`);
  process.exit(2);
}

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const WRITE = process.argv.includes("--write");
const ALLOW_PUBLIC = process.argv.includes("--allow-public");
const SINCE = argValue("--since") ?? null;
if (SINCE !== null && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  console.error(`--since must be YYYY-MM-DD, got ${SINCE}`);
  process.exit(2);
}
const MAX_TX = Number(argValue("--max-tx") || process.env.SOLANA_HOLDERS_REPLAY_MAX_TX) || 50_000;
if (!Number.isInteger(MAX_TX) || MAX_TX < 1) {
  console.error(`--max-tx must be a positive integer, got ${MAX_TX}`);
  process.exit(2);
}
const CONCURRENCY = Number(process.env.SOLANA_FLOW_CONCURRENCY) || 4;
const REQUESTS_PER_SECOND = Number(process.env.SOLANA_HOLDERS_REPLAY_RPS) || 10;
const COST_SAMPLE_OWNERS = 10;
const CHECKPOINT_VERSION = 1;

const chain = chains[0];
const { key: chainKey, mint, decimals } = chain;
const program = solanaBaseToken(chain.chain)?.program ?? "spl-token";
const programId = PROGRAM_BY_NAME[program];
if (!programId) throw new Error(`${project.slug}: unknown token program "${program}" (expected spl-token or token-2022)`);

const tiers = projectHolderTiers(project);
setHolderTiers(tiers);
const retailThreshold = tiers.retailThreshold;
const { set: nonRetail } = await loadNonRetailSet(projectNonRetailPaths(project));

const data = projectPaths(project);
const work = projectWork(project);
const CHECKPOINT_PATH = work("holders-replay-solana.checkpoint.json");
const HISTORY_PATH = data("holders-history.json");
const EVER_PATH = data("holders-ever-checkpoint.json");

const readOptionalJson = async (p) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
};

const { configureSolanaChain, getUsableSolanaRpcUrls, requireKeyedSolanaRpc, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
configureSolanaChain(chain.chain);
const urls = await getUsableSolanaRpcUrls(chainKey);
if (!ALLOW_PUBLIC) requireKeyedSolanaRpc(urls, chainKey);
const call = (method, params) => solanaCallWithFailover(urls, method, params, { chainKey });

/** Signatures of one account, up to `maxPages` pages of 1000. */
async function sampleSignatureCount(account, maxPages = 3) {
  let count = 0;
  let before = null;
  for (let page = 0; page < maxPages; page += 1) {
    const opts = { limit: 1000, commitment: "finalized" };
    if (before) opts.before = before;
    const rows = (await call("getSignaturesForAddress", [account, opts])) ?? [];
    count += rows.length;
    if (rows.length < 1000) break;
    before = rows[rows.length - 1].signature;
  }
  return count;
}

/** Cost estimate from a sample of retail owners of the latest snapshot. */
async function printCostEstimate(snapshot) {
  const owners = (snapshot?.wallets ?? []).map((w) => w.address).filter((a) => a && !nonRetail.has(a));
  const step = Math.max(1, Math.floor(owners.length / COST_SAMPLE_OWNERS));
  const sample = owners.filter((_, i) => i % step === 0).slice(0, COST_SAMPLE_OWNERS);
  let accounts = 0;
  let signatures = 0;
  for (const owner of sample) {
    const res = await call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
    for (const a of res?.value ?? []) {
      accounts += 1;
      signatures += await sampleSignatureCount(a.pubkey);
    }
  }
  if (accounts === 0) {
    console.log(`Cost estimate: no sampled retail owner holds ${mint}; cannot estimate from this snapshot.`);
    return;
  }
  const estimate = estimateReplayCost({
    trackedAccounts: Math.round(owners.length * (accounts / sample.length)),
    meanSignaturesPerAccount: signatures / accounts,
    maxTx: MAX_TX,
    requestsPerSecond: REQUESTS_PER_SECOND,
  });
  console.log(
    [
      `Cost estimate for ${project.slug} (${chainKey}, ${mint}), sampled from ${sample.length} retail owners:`,
      `  tracked token accounts  ~${estimate.trackedAccounts.toLocaleString()}`,
      `  signatures to replay    ~${estimate.signatures.toLocaleString()} (upper bound; ${(signatures / accounts).toFixed(1)} per sampled account)`,
      `  this run (--max-tx ${MAX_TX.toLocaleString()})  ~${estimate.callsPerRun.toLocaleString()} RPC calls, ~${estimate.hoursPerRunAt.toFixed(1)} h at ${REQUESTS_PER_SECOND} req/s`,
      `  full catch-up          ~${estimate.runsToCatchUp} run(s), ~${estimate.totalCalls.toLocaleString()} RPC calls, ~${estimate.hoursTotalAt.toFixed(1)} h at ${REQUESTS_PER_SECOND} req/s`,
      `  mode                    ${WRITE ? "--write (publishes once caught up)" : "dry run (checkpoint only, public/data untouched)"}`,
    ].join("\n"),
  );
}

/** Lists signatures of every tracked account and returns the merged, ordered batch plus per-account lists. */
async function listAccounts(tracked) {
  return mapLimit([...tracked.entries()], CONCURRENCY, async ([account, cursor]) => ({
    account,
    owner: cursor.owner,
    until: cursor.until,
    sigs: await listSignatures(call, account, { until: cursor.until }),
  }));
}

/** getTransaction for each signature of the batch; a missing result aborts (a gap would corrupt balances). */
async function fetchTransactions(batch) {
  const txs = await mapLimit(batch, CONCURRENCY, (s) =>
    call("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }]),
  );
  txs.forEach((tx, i) => {
    if (!tx) throw new Error(`getTransaction ${batch[i].signature}: no result. Refusing a partial replay; rerun to retry.`);
  });
  return txs;
}

/** Owner -> summed raw balance across the discovered accounts (reconciliation). */
function discoveredTotals(rows) {
  const totals = new Map();
  for (const row of rows) totals.set(row.owner, (totals.get(row.owner) ?? 0n) + row.raw);
  return totals;
}

function countMismatches(ledgerBalances, discovered) {
  const owners = new Set([...ledgerBalances.keys(), ...discovered.keys()]);
  let mismatches = 0;
  for (const owner of owners) {
    if ((ledgerBalances.get(owner) ?? 0n) !== (discovered.get(owner) ?? 0n)) mismatches += 1;
  }
  return mismatches;
}

async function main() {
  console.log(`Replaying ${project.slug} ${chainKey} ${mint} (${program}, ${decimals} decimals).`);
  const snapshot = await readOptionalJson(data("tel-holders.json"));
  await printCostEstimate(snapshot);

  const prev = await readOptionalJson(CHECKPOINT_PATH);
  const compatible =
    prev?.version === CHECKPOINT_VERSION && prev.mint === mint && prev.chainKey === chainKey && prev.decimals === decimals && prev.retailThreshold === retailThreshold;
  if (prev && !compatible) console.warn("Checkpoint does not match this token or thresholds; restarting the replay from genesis.");
  const state = compatible ? restoreReplayState(prev.state) : createReplayState();
  const priorAccounts = compatible ? prev.accounts : {};

  const cexHistory = await readOptionalJson(data("cex-balance-history.json"));
  const ctx = { chainKey, decimals, nonRetail, retailThreshold, cexBalanceAsOf: cexBalanceAsOf(cexHistory?.entries) };

  const res = await call("getProgramAccounts", [programId, holderScanParams(mint, program)]);
  const discovered = trackedTokenAccounts(Array.isArray(res) ? res : res?.value, { mint, nonRetail });
  const tracked = new Map(Object.entries(priorAccounts).map(([account, c]) => [account, c]));
  for (const { account, owner } of discovered) tracked.set(account, { owner, until: priorAccounts[account]?.until ?? null });
  console.log(`Discovered ${discovered.length.toLocaleString()} retail token accounts (${tracked.size.toLocaleString()} tracked incl. checkpoint).`);

  const lists = await listAccounts(tracked);
  const bySig = new Map();
  for (const { sigs } of lists) for (const s of sigs) if (!bySig.has(s.signature)) bySig.set(s.signature, s);
  const ordered = [...bySig.values()].sort(bySlotThenSig);
  const batch = takeWholeSlots(ordered, MAX_TX);
  const done = new Set(batch.map((s) => s.signature));
  const remaining = ordered.length - batch.length;
  console.log(`Signatures: ${ordered.length.toLocaleString()} new, processing ${batch.length.toLocaleString()} this run, ${remaining.toLocaleString()} left.`);

  const txs = await fetchTransactions(batch);
  replayTransactions(
    state,
    batch.map((s, i) => ({ blockTime: s.blockTime, deltas: mintDeltasByOwner(txs[i], mint) })),
    ctx,
  );
  const caughtUp = remaining === 0;
  if (caughtUp) finalizeReplay(state, Math.floor(Date.now() / 1000), ctx);

  const cursors = {};
  for (const [account, cursor] of tracked) cursors[account] = { owner: cursor.owner, until: cursor.until };
  for (const { account, owner, until, sigs } of lists) {
    const newestDone = sigs.find((s) => done.has(s.signature));
    cursors[account] = { owner, until: newestDone ? newestDone.signature : until };
  }
  await fs.mkdir(work.dir, { recursive: true });
  await fs.writeFile(
    CHECKPOINT_PATH,
    JSON.stringify({
      version: CHECKPOINT_VERSION,
      chainKey,
      mint,
      decimals,
      retailThreshold,
      accounts: cursors,
      state: serializeReplayState(state),
    }),
    "utf8",
  );
  console.log(`Checkpoint: ${CHECKPOINT_PATH} (${state.entries.length} daily entries, ${state.balances.size.toLocaleString()} holders with balance).`);
  if (state.outOfOrder > 0) console.warn(`  ${state.outOfOrder} transactions arrived out of time order; daily snapshots before them may be stale.`);
  if (state.anomalies > 0) console.warn(`  ${state.anomalies} balance applications went negative: some token accounts were missing from discovery.`);

  if (!caughtUp) {
    console.log(`Not caught up (${remaining.toLocaleString()} signatures left). Public data untouched; rerun to continue.`);
    return;
  }
  const mismatches = countMismatches(state.balances, discoveredTotals(discovered));
  console.log(`Reconciliation: ${mismatches} owner(s) differ from the on-chain token-account sum at discovery (expected: a few, from transfers landing during the run).`);

  const replayed = state.entries.filter((e) => SINCE === null || e.date >= SINCE);
  const last = state.entries.at(-1);
  console.log(
    `Replay caught up: ${replayed.length} daily entries${SINCE ? ` from ${SINCE}` : ""}, latest ${last?.date ?? "none"} with ${last?.combined.holderCount ?? 0} holders (${last?.combined.cumulativeHolders ?? state.cumulativeHolders} ever held).`,
  );
  if (!WRITE) {
    console.log("Dry run: public/data untouched. Pass --write to publish.");
    return;
  }
  const existing = (await readOptionalJson(HISTORY_PATH))?.entries ?? [];
  const entries = mergeHistoryEntries(existing, replayed);
  await fs.writeFile(
    HISTORY_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), source: "rebuild-holders-history-solana", entries }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${HISTORY_PATH} (${entries.length} entries).`);
  await fs.writeFile(
    EVER_PATH,
    JSON.stringify({ generatedAt: last?.date ?? null, cumulativeHolders: state.cumulativeHolders, addresses: [...state.firstSeen.keys()].sort() }),
    "utf8",
  );
  console.log(`Wrote ${EVER_PATH}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
