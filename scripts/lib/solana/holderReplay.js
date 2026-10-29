/**
 * Solana holders-history replay: the pure day-snapshot and new-holder logic
 * behind scripts/rebuild-holders-history-solana.js. No RPC in this file.
 *
 * Input is the token's transactions in ascending blockTime order, each reduced
 * to per-owner mint deltas (mintDeltasByOwner in ./tokenFlows.js). The ledger
 * is the running balance per owner, so every snapshot is exact wherever the
 * history fed in is complete.
 *
 * Snapshot semantics: the entry for UTC date D is the end-of-day state, the
 * ledger after every transaction with blockTime < end of D. A date is emitted
 * only once a transaction at or after its end has been applied (or a caught-up
 * replay is finalized), so no entry is ever built from part of its day.
 *
 * Classification follows scripts/generate-holders-history.js: owners in the
 * non-retail set (exclusions, CEX, DEX) are never holders and never count as
 * new. Retail vs under-threshold is computeChainMetrics's retailThreshold split.
 */
import { computeChainMetrics } from "../holderMetrics.js";
import { CONCENTRATION_BUCKETS, DISTRIBUTION_RANGES } from "../holdersView.js";
import { reconcileHistoryEntry } from "../holderHistoryReconcile.js";
import { rawToNumber } from "./metadata.js";

const DAY_SECONDS = 86_400;
const CARRIED_STAKING_FIELDS = ["stakingBalance", "stakingV3Balance", "dexLiquidity"];

export const utcDateOf = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
export const dayEndSeconds = (date) => Date.parse(`${date}T00:00:00Z`) / 1000 + DAY_SECONDS;
export const nextUtcDate = (date) => utcDateOf(dayEndSeconds(date));

export function createReplayState() {
  return {
    balances: new Map(), // owner -> raw bigint, zero balances removed
    firstSeen: new Map(), // owner -> first emitted date holding > 0
    cumulativeHolders: 0,
    nextDate: null, // next UTC date waiting to be emitted
    lastBlockTime: null,
    outOfOrder: 0, // transactions older than the last applied one (should stay 0)
    anomalies: 0, // applications that left an owner negative: history is incomplete
    entries: [],
  };
}

/** Adds each owner's delta to the ledger. Non-retail owners are not tracked at all. */
function applyDeltas(state, deltas, ctx) {
  for (const [owner, delta] of deltas) {
    if (ctx.nonRetail.has(owner)) continue;
    const next = (state.balances.get(owner) ?? 0n) + delta;
    if (next < 0n) state.anomalies += 1;
    if (next === 0n) state.balances.delete(owner);
    else state.balances.set(owner, next);
  }
}

/** Same bucket rule as rebuild-history-from-logs.js buildDistribution (kept in step). */
function buildDistribution(holders) {
  return DISTRIBUTION_RANGES.map((range) => {
    const bucket = holders.filter((h) => h.balance >= range.min && h.balance < range.max);
    return {
      label: range.label,
      count: bucket.length,
      totalBalance: Math.round(bucket.reduce((s, h) => s + h.balance, 0)),
    };
  }).filter((row) => row.count > 0 || row.totalBalance > 0);
}

/** Top-N balance sums over a descending-sorted balance array. */
function concentrationOf(sortedDesc) {
  const out = {};
  for (const bucket of CONCENTRATION_BUCKETS) {
    out[bucket] = Math.round(sortedDesc.slice(0, bucket).reduce((s, v) => s + v, 0));
  }
  return out;
}

/**
 * One history entry in the holders-history schema, for a single chain.
 * `holders` are the classified holders (non-retail already removed).
 */
export function buildDayEntry({ chainKey, date, holders, cexBalance, newHolders, cumulativeHolders, retailThreshold }) {
  const metrics = computeChainMetrics(holders, { retailThreshold });
  const distribution = buildDistribution(holders);
  const concentration = concentrationOf(holders.map((h) => h.balance).sort((a, b) => b - a));
  const combined = {
    holderCount: metrics.holderCount,
    retailHolderCount: metrics.retail.count,
    totalBalance: metrics.totalBalance,
    holderCountWithStakers: metrics.holderCount,
    cexBalance: Math.round(cexBalance),
    totalHeld: Math.round(metrics.totalBalance + cexBalance),
  };
  return reconcileHistoryEntry({
    date,
    generatedAt: `${date}T00:00:00.000Z`,
    combined,
    chains: {
      [chainKey]: {
        holderCount: metrics.holderCount,
        retailHolderCount: metrics.retail.count,
        totalBalance: metrics.totalBalance,
        distribution,
        concentration,
      },
    },
    distribution,
    concentration,
    newHolders,
    cumulativeHolders,
  });
}

/** Emits the snapshot for `date` (skipped when nobody holds anything, as the live pipeline does). */
function emitDay(state, date, ctx) {
  const holders = [];
  for (const [address, raw] of state.balances) {
    if (raw <= 0n || ctx.nonRetail.has(address)) continue;
    holders.push({ address, balance: rawToNumber(raw, ctx.decimals) });
  }
  if (holders.length === 0) return;
  let newHolders = 0;
  for (const { address } of holders) {
    if (state.firstSeen.has(address)) continue;
    state.firstSeen.set(address, date);
    newHolders += 1;
  }
  state.cumulativeHolders += newHolders;
  state.entries.push(
    buildDayEntry({
      chainKey: ctx.chainKey,
      date,
      holders,
      cexBalance: ctx.cexBalanceAsOf(date),
      newHolders,
      cumulativeHolders: state.cumulativeHolders,
      retailThreshold: ctx.retailThreshold,
    }),
  );
}

/** Emits every pending date whose end lies at or before `seconds`. */
function emitDaysEndingBy(state, seconds, ctx) {
  while (state.nextDate !== null && dayEndSeconds(state.nextDate) <= seconds) {
    emitDay(state, state.nextDate, ctx);
    state.nextDate = nextUtcDate(state.nextDate);
  }
}

/**
 * Applies transactions in ascending blockTime order. Each date is snapshotted
 * before the first transaction that falls after its end. `txs` items are
 * `{ blockTime, deltas: Map<owner, bigint> }`. Mutates and returns `state`.
 */
export function replayTransactions(state, txs, ctx) {
  for (const { blockTime, deltas } of txs) {
    if (state.lastBlockTime !== null && blockTime < state.lastBlockTime) state.outOfOrder += 1;
    if (state.nextDate === null) state.nextDate = utcDateOf(blockTime);
    emitDaysEndingBy(state, blockTime, ctx);
    applyDeltas(state, deltas, ctx);
    state.lastBlockTime = Math.max(state.lastBlockTime ?? blockTime, blockTime);
  }
  return state;
}

/**
 * Call only once the replay has caught up with the chain tip. Emits every
 * date that has ended by `nowSeconds`; the still-open current day is left out.
 */
export function finalizeReplay(state, nowSeconds, ctx) {
  emitDaysEndingBy(state, nowSeconds, ctx);
  return state;
}

export function serializeReplayState(state) {
  return {
    balances: Object.fromEntries([...state.balances].map(([owner, raw]) => [owner, raw.toString()])),
    firstSeen: Object.fromEntries(state.firstSeen),
    cumulativeHolders: state.cumulativeHolders,
    nextDate: state.nextDate,
    lastBlockTime: state.lastBlockTime,
    outOfOrder: state.outOfOrder,
    anomalies: state.anomalies,
    entries: state.entries,
  };
}

export function restoreReplayState(json) {
  return {
    balances: new Map(Object.entries(json.balances ?? {}).map(([owner, raw]) => [owner, BigInt(raw)])),
    firstSeen: new Map(Object.entries(json.firstSeen ?? {})),
    cumulativeHolders: json.cumulativeHolders ?? 0,
    nextDate: json.nextDate ?? null,
    lastBlockTime: json.lastBlockTime ?? null,
    outOfOrder: json.outOfOrder ?? 0,
    anomalies: json.anomalies ?? 0,
    entries: json.entries ?? [],
  };
}

/**
 * CEX balance as of a date, carried forward from cex-balance-history.json
 * (same rule as rebuild-history-from-logs.js). Dates before the first entry
 * take the earliest known balance, never a fabricated zero step.
 */
export function cexBalanceAsOf(cexEntries) {
  const sorted = (cexEntries ?? []).filter((e) => e?.date).sort((a, b) => a.date.localeCompare(b.date));
  return (date) => {
    let match = sorted[0] ?? null;
    for (const entry of sorted) {
      if (entry.date > date) break;
      match = entry;
    }
    return Number(match?.total ?? 0) || 0;
  };
}

/**
 * Replaces the replayed dates in `existing` and keeps every other row. A
 * replayed row keeps the staking / DEX figures the live pipeline measured for
 * the same date, since replay cannot reconstruct them.
 */
export function mergeHistoryEntries(existing, replayEntries) {
  const replayed = new Set(replayEntries.map((e) => e.date));
  const previous = new Map(existing.map((e) => [e.date, e]));
  const carried = replayEntries.map((entry) => carryStakingFields(entry, previous.get(entry.date)));
  const kept = existing.filter((e) => !replayed.has(e.date));
  return [...kept, ...carried].sort((a, b) => a.date.localeCompare(b.date));
}

function carryStakingFields(entry, old) {
  if (!old?.combined) return entry;
  const combined = { ...entry.combined };
  for (const field of CARRIED_STAKING_FIELDS) {
    if (combined[field] == null && old.combined[field] != null) combined[field] = old.combined[field];
  }
  return { ...entry, combined };
}

/**
 * Token accounts worth replaying: every account of the mint whose owner is
 * not in the non-retail set. Non-retail owners' transfers still appear through
 * the retail side of each transfer, so skipping their own accounts is lossless
 * for the retail ledger and avoids listing the heaviest (CEX) histories.
 * `rows` is a getProgramAccounts result (zero-balance accounts included, since
 * they still carry history).
 */
export function trackedTokenAccounts(rows, { mint, nonRetail }) {
  const out = [];
  for (const row of rows ?? []) {
    const info = row?.account?.data?.parsed?.info;
    if (!info || info.mint !== mint || typeof info.owner !== "string" || !row.pubkey) continue;
    if (nonRetail.has(info.owner)) continue;
    out.push({ account: row.pubkey, owner: info.owner, raw: BigInt(info.tokenAmount?.amount ?? "0") });
  }
  return out;
}

/**
 * Oldest-first prefix of `sorted` of at most `max` items that never splits a
 * slot: same-slot signatures can come back in a different order per call, so
 * a slot must be processed whole or deferred whole.
 */
export function takeWholeSlots(sorted, max) {
  let cut = Math.min(sorted.length, Math.max(0, max));
  while (cut > 0 && cut < sorted.length && sorted[cut].slot === sorted[cut - 1].slot) cut += 1;
  return sorted.slice(0, cut);
}

/**
 * Work and RPC volume of a full replay, from sampled per-account signature
 * counts. Every run re-lists every tracked account (one call each, cursor
 * permitting), plus one getTransaction per signature processed.
 * `signatures` is an upper bound: a transfer between two tracked accounts is
 * listed under both, so unique transactions are fewer.
 */
export function estimateReplayCost({ trackedAccounts, meanSignaturesPerAccount, maxTx, requestsPerSecond }) {
  const signatures = Math.round(trackedAccounts * meanSignaturesPerAccount);
  const runsToCatchUp = Math.max(1, Math.ceil(signatures / maxTx));
  const txPerRun = Math.min(signatures, maxTx);
  const callsPerRun = 1 + trackedAccounts + txPerRun;
  const totalCalls = runsToCatchUp * (1 + trackedAccounts) + signatures;
  return {
    trackedAccounts,
    signatures,
    runsToCatchUp,
    txPerRun,
    callsPerRun,
    totalCalls,
    hoursPerRunAt: callsPerRun / requestsPerSecond / 3600,
    hoursTotalAt: totalCalls / requestsPerSecond / 3600,
  };
}
