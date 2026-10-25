/**
 * Solana flow primitives. There is no Transfer-log range scan on Solana:
 * flows come from per-transaction token balance deltas
 * (getSignaturesForAddress on a venue token account -> getTransaction jsonParsed).
 * Owners are kept exactly as returned (base58 is case-sensitive).
 */
export function mintDeltasByOwner(tx, mint) {
  const out = new Map();
  if (!tx?.meta || tx.meta.err) return out;
  const add = (owner, v) => {
    if (owner) out.set(owner, (out.get(owner) ?? 0n) + v);
  };
  const pre = new Map();
  for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === mint) pre.set(b.accountIndex, b);
  const seen = new Set();
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint !== mint) continue;
    seen.add(b.accountIndex);
    const before = BigInt(pre.get(b.accountIndex)?.uiTokenAmount?.amount ?? "0");
    add(b.owner, BigInt(b.uiTokenAmount?.amount ?? "0") - before);
  }
  for (const [idx, b] of pre) if (!seen.has(idx)) add(b.owner, -BigInt(b.uiTokenAmount?.amount ?? "0"));
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}

export function classifyFlow(deltas, { cex = new Set(), dex = new Set() } = {}) {
  return [...deltas.entries()].map(([owner, v]) => ({
    owner,
    raw: (v < 0n ? -v : v).toString(),
    side: v < 0n ? "out" : "in",
    venue: cex.has(owner) ? "cex" : dex.has(owner) ? "dex" : null,
  }));
}
