import { normalizeAddress } from "./nonRetailSet.js";

const EMPTY_SET = new Set();

/** Every address currently classified as a retail holder in this snapshot
 *  (balance > 0 on any chain, not in the CURRENT non-retail set) — used to
 *  rebuild newHolders/cumulativeHolders chronologically. Schema-tolerant:
 *  snapshots from 2025-12-31 onward have a top-level `wallets[]`; older ones
 *  (TEL back to 2025-10-12) only have `combined.holders[]` with
 *  `{address, balance, chain}` — no per-chain breakdown, but enough to know an
 *  address held the token. */
export const extractHeldAddresses = (snapshot, excluded, dropped = EMPTY_SET) => {
  const addrs = new Set();
  if (Array.isArray(snapshot?.wallets) && snapshot.wallets.length) {
    const chainKeys = Object.keys(snapshot?.chains ?? {});
    for (const w of snapshot.wallets) {
      const a = normalizeAddress(w?.address);
      if (!a || excluded.has(a) || dropped.has(a)) continue;
      if (chainKeys.some((k) => Number(w?.[`${k}_balance`]) > 0)) addrs.add(a);
    }
  } else {
    for (const h of snapshot?.combined?.holders ?? []) {
      const a = normalizeAddress(h?.address);
      if (a && !excluded.has(a) && !dropped.has(a) && Number(h?.balance) > 0) addrs.add(a);
    }
  }
  return addrs;
};

/**
 * Folds one day's held addresses into the running ever-held set (mutates it).
 *
 * `baseline: true` is for a project whose archive has no snapshot older than
 * its first history row (ZBCN: tracking began 2026-10-25). Seeding the set from
 * nothing would report the entire first-day holder base as "new" and, through
 * the cumulative count, inflate every later day by the same amount of nothing —
 * so the first day only seeds: it gets a cumulative count (the size of the
 * baseline) and `newHolders: null`, because new-vs-existing is unknowable
 * without replaying Transfer history from before tracking began.
 */
export const advanceEverHeld = (everSeen, heldAddrs, { baseline = false } = {}) => {
  let added = 0;
  for (const a of heldAddrs) {
    if (!everSeen.has(a)) {
      everSeen.add(a);
      added++;
    }
  }
  return { newHolders: baseline ? null : added, cumulativeHolders: everSeen.size };
};
