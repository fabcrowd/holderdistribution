/**
 * Range-aware tier rows: today's distribution re-based against the archive's
 * distribution at the start of the selected window. Shared by the stacked
 * Distribution widget and the desktop terminal so both print the same deltas.
 */
export type DistributionRowInput = {
  label: string;
  count: number;
  totalBalance: number;
  percent: number;
  previousCount?: number | null;
  previousTotalBalance?: number | null;
  previousPercent?: number | null;
};

export type HistoricalRowInput = { label: string; count: number; totalBalance: number };

export const mergeDistributionBaseline = <T extends DistributionRowInput>(
  baseRows: T[],
  historicalRows: HistoricalRowInput[] | null | undefined,
): T[] => {
  if (!historicalRows) return baseRows;
  const byLabel = new Map(historicalRows.map((r) => [r.label, r]));
  const historicalTotal = historicalRows.reduce((sum, r) => sum + r.totalBalance, 0);
  return baseRows.map((row) => {
    const h = byLabel.get(row.label);
    if (!h) return { ...row, previousCount: null, previousTotalBalance: null, previousPercent: null };
    return {
      ...row,
      previousCount: h.count,
      previousTotalBalance: h.totalBalance,
      previousPercent: historicalTotal > 0 ? (h.totalBalance / historicalTotal) * 100 : null,
    };
  });
};

/** "N of M tiers gained holders" plus the net wallet change across tiers. */
export const summarizeTierGrowth = (rows: DistributionRowInput[]) => {
  const withBaseline = rows.filter((r) => (r.previousCount ?? null) !== null);
  return {
    tiers: withBaseline.length,
    grew: withBaseline.filter((r) => r.count > (r.previousCount ?? 0)).length,
    netWallets: withBaseline.reduce((s, r) => s + (r.count - (r.previousCount ?? r.count)), 0),
  };
};
