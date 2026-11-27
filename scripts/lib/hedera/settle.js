/**
 * Settle a Hedera balance snapshot to the end of a block.
 *
 * Mirror snapshots are about 15 minutes apart, so none falls on a day boundary. The
 * state at block B is the newest snapshot S at or before B's last consensus time E,
 * plus every transaction with S < consensus_timestamp <= E (a snapshot includes the
 * transactions at its own stamp: measured 2026-11-11). Over one live snapshot interval
 * (902 s, 8,416 transactions, 267 failed) this matched the next snapshot to the
 * tinybar for all 169 touched accounts.
 *
 * The scan keeps a row for every positive balance (floor 1 tinybar, owner 2026-11-14), so an account the
 * window touches that has no row (zero at S, or created after S) is read on its own at S, usually a few
 * hundred per window. An account that ends at 0 leaves the rows; each transaction nets to zero, so the
 * settled rows still add up to total supply.
 */
import { applyHbarTransfers } from "./replay.js";
import { balanceAtSnapshot } from "./scan.js";

/**
 * Network accounts whose replayed balance may dip below zero for a moment, and by how much.
 *
 * 0.0.802 is the network's fee collection account: every transaction's fee lands there, and at
 * the start of each staking period (00:00 UTC) a synthetic "Synthetic node fees payment"
 * CRYPTOTRANSFER (payer 0.0.50, nonce 1) sweeps it out to the nodes, 0.0.98, 0.0.800 and 0.0.801.
 * The sweep pays out fees of the same round whose credit legs carry LATER consensus timestamps, so
 * replaying the mirror's legs in consensus order leaves 0.0.802 a few hundred thousand tinybar per
 * pending fee below zero until those legs arrive, a few seconds later. Measured 2026-11-27: snapshot
 * 1795736945.724729029 holds 967,086,010,610; the 3,218 transactions touching 0.0.802 through
 * 1795737600.496080104 (the end of block 102820212) net -967,089,229,109, the sweep at
 * 1795737600.244329119 being -969,927,274,858, so the replay ends at -3,218,499 tinybar
 * (~17 fees of 184,941). Replaying the same legs on to the next snapshot (1795737846.746712391)
 * gives 1,622,307,294, equal to the mirror's balance to the tinybar, and so does the interval
 * before it: the legs are complete, only their order is. On 2026-11-26 the same sweep
 * (702,221,830,015) left a margin, so the settle passed.
 *
 * Such an account ends the settle at 0 (no row) and the dip is reported (`transientNegative`),
 * so the listed rows exceed total supply by exactly that amount and the caller accounts for it.
 * Any other account below zero, or a listed one by more than `maxTinybar`, still stops the settle.
 * A chain config can replace the list with `settle.transientNegative: { accounts, maxTinybar }`.
 */
export const HEDERA_TRANSIENT_NEGATIVE = Object.freeze({
  accounts: Object.freeze(["0.0.802"]),
  // 1 HBAR: ~540 fees at today's 184,941 tinybar, two orders above the dip measured above.
  maxTinybar: 100_000_000n,
});

/** The chain's transient-negative rule: `chain.settle.transientNegative`, else HEDERA_TRANSIENT_NEGATIVE. */
export function transientNegativeRule(chain) {
  const custom = chain?.settle?.transientNegative;
  if (custom == null) return HEDERA_TRANSIENT_NEGATIVE;
  const accounts = custom.accounts ?? [];
  if (!Array.isArray(accounts) || !accounts.every((a) => typeof a === "string" && /^0\.0\.[1-9]\d{0,15}$/.test(a))) {
    throw new Error(`chain ${chain?.key}: settle.transientNegative.accounts must be 0.0.N ids`);
  }
  const max = BigInt(custom.maxTinybar ?? 0);
  if (max < 0n) throw new Error(`chain ${chain?.key}: settle.transientNegative.maxTinybar must be >= 0`);
  return { accounts, maxTinybar: max };
}

const nanos = (stamp) => {
  const [s, f = ""] = String(stamp).split(".");
  return BigInt(s) * 1_000_000_000n + BigInt(f.padEnd(9, "0").slice(0, 9));
};

/** Every transaction with after < consensus_timestamp <= through, in consensus order. */
export async function fetchTransactionsBetween(client, { after, through }) {
  const out = [];
  let path = `/transactions?timestamp=gt:${after}&timestamp=lte:${through}&order=asc&limit=100`;
  let last = nanos(after);
  while (path) {
    const body = await client.getJson(path);
    if (!body || !Array.isArray(body.transactions) || !body.links || !("next" in body.links)) {
      throw new Error(`hedera /transactions: unreadable page for ${path}`);
    }
    for (const tx of body.transactions) {
      const t = nanos(tx.consensus_timestamp);
      if (t <= last || t > nanos(through)) throw new Error(`hedera /transactions: ${tx.consensus_timestamp} out of order or outside (${after}, ${through}]`);
      last = t;
      out.push(tx);
    }
    path = body.links.next ? body.links.next.replace(/^\/api\/v1/, "") : null;
  }
  return out;
}

/**
 * rows: [[num, tinybarText]] at or above `floor` in snapshot `stamp` (answered by `cluster`).
 * Returns { rows, transactions, failedTransactions, touched, lookups, maxTouched, transientNegative,
 * transientNegativeRaw } with rows at or above `floor` at the end of `through`, in id order.
 * `transientNegative`: { id: tinybarText } for listed accounts (HEDERA_TRANSIENT_NEGATIVE) that ended
 * below zero and were set to 0; `transientNegativeRaw` is their sum (<= 0n), so the listed rows add up
 * to total supply minus it.
 */
export async function settleRows(client, { rows, stamp, cluster, through, floor, transientNegative = HEDERA_TRANSIENT_NEGATIVE, ...waitOpts }) {
  const txs = await fetchTransactionsBetween(client, { after: stamp, through });
  const byNum = new Map(rows.map(([num, text]) => [num, BigInt(text)]));
  const touched = [...new Set(txs.flatMap((tx) => (tx.transfers ?? []).map((leg) => leg.account)))];
  const baseline = new Map();
  let lookups = 0;
  for (const id of touched) {
    const num = Number(String(id).slice(4));
    if (byNum.has(num)) baseline.set(id, byNum.get(num));
    else {
      baseline.set(id, await balanceAtSnapshot(client, { id, stamp, cluster, ...waitOpts }));
      lookups += 1;
    }
  }
  const after = applyHbarTransfers(baseline, txs);
  const dipAllowed = new Set(transientNegative?.accounts ?? []);
  const dipMax = BigInt(transientNegative?.maxTinybar ?? 0n);
  const dips = {};
  let dipRaw = 0n;
  let maxTouched = 0;
  for (const [id, raw] of after) {
    if (raw < 0n && dipAllowed.has(id) && -raw <= dipMax) {
      dips[id] = String(raw);
      dipRaw += raw;
      byNum.delete(Number(id.slice(4)));
      continue;
    }
    if (raw < 0n) {
      const why = dipAllowed.has(id) ? ` (more than its allowed transient dip of ${dipMax})` : "";
      throw new Error(`hedera settle: ${id} would hold ${raw} tinybar at ${through}${why}`);
    }
    const num = Number(id.slice(4));
    maxTouched = Math.max(maxTouched, num);
    if (raw >= BigInt(floor)) byNum.set(num, raw);
    else byNum.delete(num);
  }
  return {
    rows: [...byNum].sort((a, b) => a[0] - b[0]).map(([num, raw]) => [num, String(raw)]),
    transactions: txs.length,
    failedTransactions: txs.filter((tx) => tx.result !== "SUCCESS").length,
    touched: touched.length,
    lookups,
    maxTouched,
    transientNegative: dips,
    transientNegativeRaw: dipRaw,
  };
}
