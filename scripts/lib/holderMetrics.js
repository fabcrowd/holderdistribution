/**
 * Pure metrics helpers for TEL holder snapshots.
 *
 * One place computes retail.count (>= retailThreshold) so RPC, resync, and
 * summary never diverge. Mega/excluded are tracked separately during scans
 * and merged by callers.
 */

export const RETAIL_THRESHOLD = 1_000;
export const MEGA_HOLDER_THRESHOLD = 20_000_000_000;

export const createEmptyMetrics = () => ({
  holderCount: 0,
  totalBalance: 0,
  retail: { count: 0, balance: 0 },
  underThreshold: { count: 0, balance: 0 },
  mega: { count: 0, balance: 0 },
  excluded: { count: 0, balance: 0 },
});

/**
 * Compute holderCount / totalBalance / retail / underThreshold from a holders
 * array (non-excluded, non-mega entries with balance > 0).
 *
 * @param {Array<{ balance?: number }>} holders
 * @param {{ retailThreshold?: number }} [options]
 */
export const computeChainMetrics = (holders, { retailThreshold = RETAIL_THRESHOLD } = {}) => {
  const metrics = {
    holderCount: 0,
    totalBalance: 0,
    retail: { count: 0, balance: 0 },
    underThreshold: { count: 0, balance: 0 },
  };

  for (const holder of holders ?? []) {
    const balance = Number(holder?.balance);
    if (!Number.isFinite(balance) || balance <= 0) continue;
    metrics.holderCount += 1;
    metrics.totalBalance += balance;
    if (balance >= retailThreshold) {
      metrics.retail.count += 1;
      metrics.retail.balance += balance;
    } else {
      metrics.underThreshold.count += 1;
      metrics.underThreshold.balance += balance;
    }
  }

  return metrics;
};

/**
 * Build holders-summary.json shape from a tel-holders snapshot.
 *
 * @param {object} snapshot
 * @param {{ snapshotDate?: string }} [options]
 */
export const buildSummary = (snapshot, { snapshotDate } = {}) => {
  const generatedAt = snapshot?.generatedAt ?? new Date().toISOString();
  const date =
    snapshotDate ??
    snapshot?.source?.snapshotDate ??
    (typeof generatedAt === "string" ? generatedAt.slice(0, 10) : new Date().toISOString().slice(0, 10));

  const combined = snapshot?.combined ?? createEmptyMetrics();
  const chains = {};
  for (const [key, chain] of Object.entries(snapshot?.chains ?? {})) {
    const m = chain?.metrics ?? createEmptyMetrics();
    chains[key] = {
      holderCount: m.holderCount ?? 0,
      retailHolderCount: m.retail?.count ?? 0,
    };
  }

  return {
    generatedAt,
    snapshotDate: date,
    combined: {
      holderCount: combined.holderCount ?? 0,
      retailHolderCount: combined.retail?.count ?? 0,
      totalBalance: combined.totalBalance ?? 0,
      // Stakers are merged into polygon balances before metrics; no separate add.
      holderCountWithStakers: combined.holderCount ?? 0,
    },
    chains,
  };
};
