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

/**
 * Every mint's per-owner delta in one pass: Map<owner, Map<mint, { raw, decimals, account }>>.
 * `account` is the token account of the first (owner, mint) account seen in the balance lists.
 */
export function allMintDeltasByOwner(tx) {
  const out = new Map();
  if (!tx?.meta || tx.meta.err) return out;
  const pre = indexByAccountIndex(tx.meta.preTokenBalances);
  const post = indexByAccountIndex(tx.meta.postTokenBalances);
  for (const accountIndex of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(accountIndex);
    const after = post.get(accountIndex);
    const ref = after ?? before;
    if (!ref?.owner || !ref.mint) continue;
    const delta = BigInt(after?.uiTokenAmount?.amount ?? "0") - BigInt(before?.uiTokenAmount?.amount ?? "0");
    addTokenDelta(out, ref, delta, tokenAccountAt(tx, accountIndex));
  }
  dropZeroDeltas(out);
  return out;
}

/** Native SOL change for `owner`; the fee payer (index 0) gets its fee added back. */
export function nativeSolDelta(tx, owner) {
  const meta = tx?.meta;
  const keys = tx?.transaction?.message?.accountKeys;
  if (!meta || !Array.isArray(keys)) return 0n;
  const index = keys.findIndex((key) => accountKeyOf(key) === owner);
  if (index < 0) return 0n;
  const pre = meta.preBalances?.[index];
  const post = meta.postBalances?.[index];
  if (pre == null || post == null) return 0n;
  const delta = BigInt(post) - BigInt(pre);
  return index === 0 ? delta + BigInt(meta.fee ?? 0) : delta;
}

function indexByAccountIndex(balances) {
  return new Map((balances ?? []).map((b) => [b.accountIndex, b]));
}

function accountKeyOf(key) {
  return typeof key === "string" ? key : (key?.pubkey ?? null);
}

function tokenAccountAt(tx, accountIndex) {
  const keys = tx.transaction?.message?.accountKeys;
  return keys ? accountKeyOf(keys[accountIndex]) : null;
}

function addTokenDelta(out, ref, delta, account) {
  const byMint = out.get(ref.owner) ?? new Map();
  const entry = byMint.get(ref.mint) ?? { raw: 0n, decimals: ref.uiTokenAmount?.decimals, account };
  byMint.set(ref.mint, { ...entry, raw: entry.raw + delta });
  out.set(ref.owner, byMint);
}

function dropZeroDeltas(out) {
  for (const [owner, byMint] of out) {
    for (const [mint, entry] of byMint) if (entry.raw === 0n) byMint.delete(mint);
    if (byMint.size === 0) out.delete(owner);
  }
}
