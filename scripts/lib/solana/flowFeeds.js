/**
 * Day store + feed builders for the Solana venue-flow scan.
 *
 * The store (data/<slug>/solana-flow-days.json, NOT served) keeps exact raw
 * integer sums per UTC day and per (kind, venue, counterparty) so that
 *   - exchange-flow-history.json (same shape the EVM scanner writes), and
 *   - the Solana leg of tier-outflows.json (counterparty -> tier at that date)
 * are both pure functions of it. Raw sums are decimal strings (BigInt-safe).
 * Applying the same events twice is prevented by the signature checkpoint, and
 * rebuilding a feed from the store is idempotent.
 */
import { rawToNumber } from "./metadata.js";

export const FLOW_STORE_SCHEMA = 1;
export const KEEP_DAYS = 371;

const add = (a, b) => (BigInt(a ?? "0") + BigInt(b)).toString();

export const emptyFlowStore = () => ({ schema: FLOW_STORE_SCHEMA, chains: {} });

/** Folds classified events into store.chains[chainKey].days (mutates `store`). */
export function applyFlowEvents(store, chainKey, events) {
  const days = ((store.chains[chainKey] ??= { days: {} }).days);
  for (const e of events) {
    const d = (days[e.date] ??= { totals: {}, byExchange: {}, counterparties: {} });
    d.totals[e.kind] = add(d.totals[e.kind], e.raw);
    if (e.kind === "cexIn" || e.kind === "cexOut") {
      const x = (d.byExchange[e.venue] ??= {});
      x[e.kind] = add(x[e.kind], e.raw);
    }
    if (e.counterparty && e.kind !== "internal" && e.kind !== "staking") {
      const key = `${e.kind}|${e.venue}|${e.counterparty}`;
      d.counterparties[key] = add(d.counterparties[key], e.raw);
    }
  }
  const dates = Object.keys(days).sort();
  const cutoff = dates.length ? new Date(Date.parse(dates[dates.length - 1]) - KEEP_DAYS * 86400000).toISOString().slice(0, 10) : null;
  for (const date of dates) if (cutoff && date < cutoff) delete days[date];
  return store;
}

/**
 * Idempotent fold of one delivered chunk. A crash between the store write and
 * the checkpoint write makes the same chunk come back on the next run, so the
 * signatures of the last delivered chunk are kept in lastApplied and events
 * already in it are skipped (only sums, no dedupe, otherwise).
 */
export function applyFlowEventsOnce(store, chainKey, events) {
  const applied = new Set(store.chains[chainKey]?.lastApplied ?? []);
  const fresh = events.filter((e) => e.signature === undefined || !applied.has(e.signature));
  applyFlowEvents(store, chainKey, fresh);
  if (events.length > 0) {
    const signatures = events.map((e) => e.signature).filter((s) => s !== undefined);
    store.chains[chainKey].lastApplied = [...new Set(signatures)];
  }
  return store;
}

/** `decimals`: one number, or { <chainKey>: number }. */
const decimalsOf = (decimals, chainKey) => (typeof decimals === "number" ? decimals : decimals[chainKey]);

const KINDS = ["cexIn", "cexOut", "dexIn", "dexOut"];

/**
 * exchange-flow-history entries (schema 3), every day with venue flow. The
 * caller flags the still-open UTC day with partialDay.markPartialDay.
 */
export function buildExchangeHistory(store, { decimals }) {
  const byDate = new Map();
  for (const [chainKey, chain] of Object.entries(store.chains ?? {})) {
    for (const [date, d] of Object.entries(chain.days ?? {})) {
      const leg = Object.fromEntries(KINDS.map((k) => [k, rawToNumber(d.totals?.[k] ?? "0", decimalsOf(decimals, chainKey))]));
      if (KINDS.every((k) => leg[k] === 0)) continue;
      const row = byDate.get(date) ?? { date, chains: {}, in: 0, out: 0, dexIn: 0, dexOut: 0 };
      row.chains[chainKey] = { in: leg.cexIn, out: leg.cexOut, dexIn: leg.dexIn, dexOut: leg.dexOut };
      row.in += leg.cexIn;
      row.out += leg.cexOut;
      row.dexIn += leg.dexIn;
      row.dexOut += leg.dexOut;
      byDate.set(date, row);
    }
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      date: r.date,
      chains: r.chains,
      in: Math.round(r.in),
      out: Math.round(r.out),
      net: Math.round(r.in - r.out),
      dexIn: Math.round(r.dexIn),
      dexOut: Math.round(r.dexOut),
      dexNet: Math.round(r.dexIn - r.dexOut),
    }));
}

const emptyLeg = () => ({ dex: 0, dexSwap: 0, dexLp: 0, cex: 0, moved: 0, inflows: { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 } });
const emptyBucket = () => ({
  dex: 0, dexSwap: 0, dexLp: 0, cex: 0, moved: 0,
  splitWallets: 0, splitEvents: 0, splitTel: 0, byExchange: {},
  inflows: { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 },
  byChain: {}, inflowsBySourceTier: {}, movedByDestTier: {},
});

/**
 * Tier-outflow day buckets (the generator's day-store shape) for the Solana
 * legs. Only venue-anchored flow exists: a retail counterparty's deposit to a
 * CEX (cex, byExchange), sale into a pool (dex/dexSwap), withdrawal from a CEX
 * (inflows.cex) and purchase from a pool (inflows.dex). Wallet-to-wallet moves
 * that never touch a tracked venue are NOT measured (moved/wallet stay 0; no
 * source/destination-tier attribution). LP adds cannot be told from swaps
 * without per-DEX parsing, so all pool flow is `dexSwap`.
 *
 * The counterparty's tier comes from `tierAt(date)` (Map owner -> tier of the
 * latest snapshot on/before the date); dates with no real snapshot
 * (`date < firstSnapshotDate`) and counterparties without a tier produce nothing.
 *
 * @returns {Map<string, Record<string, object>>} date -> tier -> bucket
 */
export function buildSolanaTierDays(store, { decimals, firstSnapshotDate, tierAt }) {
  const out = new Map();
  for (const [chainKey, chain] of Object.entries(store.chains ?? {})) {
    for (const [date, d] of Object.entries(chain.days ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (!firstSnapshotDate || date < firstSnapshotDate) continue;
      const tiers = tierAt(date);
      for (const [key, raw] of Object.entries(d.counterparties ?? {})) {
        const [kind, venue, owner] = key.split("|");
        const tier = tiers.get(owner);
        if (!tier) continue;
        const amt = rawToNumber(raw, decimalsOf(decimals, chainKey));
        const day = out.get(date) ?? {};
        const t = (day[tier] ??= emptyBucket());
        const leg = (t.byChain[chainKey] ??= emptyLeg());
        if (kind === "cexIn") {
          t.cex += amt; leg.cex += amt;
          t.byExchange[venue] = (t.byExchange[venue] ?? 0) + amt;
        } else if (kind === "dexIn") {
          t.dex += amt; t.dexSwap += amt; leg.dex += amt; leg.dexSwap += amt;
        } else if (kind === "cexOut") {
          t.inflows.cex += amt; leg.inflows.cex += amt;
        } else if (kind === "dexOut") {
          t.inflows.dex += amt; t.inflows.dexSwap += amt; leg.inflows.dex += amt; leg.inflows.dexSwap += amt;
        }
        out.set(date, day);
      }
    }
  }
  return out;
}
