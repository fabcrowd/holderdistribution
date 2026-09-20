/**
 * Reconcile holders-history distribution counts with holderCount.
 *
 * Historical entries predate the dust-wallet floor fix (bucket min 0 instead
 * of 1 TEL). Those sub-1-TEL wallets were always in holderCount but missing
 * from distribution[], so hero KPI deltas and Distribution Analysis tier
 * deltas disagreed by thousands of wallets.
 *
 * We cannot re-derive true per-tier balances without a full transfer replay.
 * Folding the count gap into the lowest bucket restores the invariant
 *   holderCount === sum(distribution[].count)
 * so both widgets read the same baseline. Dust balance is <1 TEL each and
 * is ignored (balance gaps in the archive come from unrelated methodology
 * changes, not dust).
 */

export const LOWEST_DISTRIBUTION_LABEL = "1-250K";

/**
 * @param {number} holderCount
 * @param {Array<{ label: string, count: number, totalBalance?: number }>|null|undefined} distribution
 * @returns {{ distribution: typeof distribution, gap: number, changed: boolean }}
 */
export const reconcileDistributionCounts = (holderCount, distribution) => {
  if (!Array.isArray(distribution) || distribution.length === 0) {
    return { distribution, gap: 0, changed: false };
  }
  const hc = Number(holderCount);
  if (!Number.isFinite(hc) || hc <= 0) {
    return { distribution, gap: 0, changed: false };
  }

  const distSum = distribution.reduce((sum, row) => sum + (Number(row?.count) || 0), 0);
  const gap = Math.round(hc - distSum);
  if (gap === 0) {
    return { distribution, gap: 0, changed: false };
  }

  // Prefer the canonical lowest-tier label; fall back to the last row
  // (DISTRIBUTION_RANGES is ordered largest→smallest).
  let idx = distribution.findIndex((row) => row?.label === LOWEST_DISTRIBUTION_LABEL);
  if (idx < 0) idx = distribution.length - 1;

  const next = distribution.map((row, i) => {
    if (i !== idx) return { ...row };
    return {
      ...row,
      count: (Number(row.count) || 0) + gap,
    };
  });

  return { distribution: next, gap, changed: true };
};

/**
 * Reconcile combined + per-chain distributions on one history entry.
 * Returns a new entry (does not mutate).
 */
export const reconcileHistoryEntry = (entry) => {
  if (!entry || typeof entry !== "object") return entry;

  let changed = false;
  const next = { ...entry, combined: entry.combined ? { ...entry.combined } : entry.combined };

  if (Array.isArray(entry.distribution)) {
    const r = reconcileDistributionCounts(entry.combined?.holderCount, entry.distribution);
    if (r.changed) {
      next.distribution = r.distribution;
      changed = true;
    }
  }

  if (entry.chains && typeof entry.chains === "object") {
    const chains = {};
    for (const [key, chain] of Object.entries(entry.chains)) {
      if (!chain || typeof chain !== "object") {
        chains[key] = chain;
        continue;
      }
      const copy = { ...chain };
      if (Array.isArray(chain.distribution)) {
        const r = reconcileDistributionCounts(chain.holderCount, chain.distribution);
        if (r.changed) {
          copy.distribution = r.distribution;
          changed = true;
        }
      }
      chains[key] = copy;
    }
    next.chains = chains;
  }

  return changed ? next : entry;
};
