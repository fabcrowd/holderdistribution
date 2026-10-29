import { normalizeAnyAddress } from "./address.js";

/**
 * Labelled wallets in `categories` that held a material balance in `previous`
 * but are absent from `current`. An absent wallet reads as 0 in every total,
 * so a silent drop here undercounts its whole category.
 *
 * Material = at least minShare of the category's previous total (and at least
 * minAbs). `allow` lists addresses whose disappearance is a known full drain.
 * Addresses are compared via normalizeAnyAddress (hex lowercased, base58 kept
 * case-sensitive).
 */
export function vanishedLabelledWallets({
  previous,
  current,
  labels,
  categories,
  previousCategoryTotals = {},
  minShare = 0.01,
  minAbs = 0,
  allow = [],
}) {
  const currentSet = new Set((current?.wallets ?? []).map((w) => normalizeAnyAddress(w?.address)));
  const prevBal = new Map();
  for (const w of previous?.wallets ?? []) {
    prevBal.set(normalizeAnyAddress(w?.address), Number(w?.total_telcoin_balance) || 0);
  }
  const allowed = new Set(allow.map(normalizeAnyAddress));

  const vanished = [];
  for (const [addr, meta] of Object.entries(labels ?? {})) {
    if (!categories.includes(meta?.category)) continue;
    const n = normalizeAnyAddress(addr);
    if (allowed.has(n)) continue;
    const previousBalance = prevBal.get(n) ?? 0;
    const floor = Math.max(minAbs, minShare * (Number(previousCategoryTotals[meta.category]) || 0));
    if (previousBalance > 0 && previousBalance >= floor && !currentSet.has(n)) {
      vanished.push({ address: n, category: meta.category, name: meta.name ?? null, previousBalance });
    }
  }
  return vanished.sort((a, b) => b.previousBalance - a.previousBalance);
}
