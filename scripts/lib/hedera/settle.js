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
 * The scan keeps only rows at or above the holder floor, so an account the window
 * touches that has no row is read on its own at S (usually a few hundred per window).
 */
import { applyHbarTransfers } from "./replay.js";
import { balanceAtSnapshot } from "./scan.js";

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
 * Returns { rows, transactions, failedTransactions, touched, lookups, maxTouched } with rows at or above
 * `floor` at the end of `through`, in id order.
 */
export async function settleRows(client, { rows, stamp, cluster, through, floor, ...waitOpts }) {
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
  let maxTouched = 0;
  for (const [id, raw] of after) {
    if (raw < 0n) throw new Error(`hedera settle: ${id} would hold ${raw} tinybar at ${through}`);
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
  };
}
