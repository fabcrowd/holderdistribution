import type { HolderEntry, HolderSnapshotBase } from "@/hooks/useHolderSnapshot";

export type DistributionBucket = {
  rangeLabel: string;
  count: number;
};

export type BalanceStats = {
  count: number;
  total: number;
  average: number;
  median: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  gini: number;
  distributionBuckets: DistributionBucket[];
  /** Range label that contains the average balance (for chart reference line) */
  averageRangeLabel: string;
};

export type StakingStats = {
  stakerCount: number;
  holderCount: number;
  stakedTotal: number;
  stakedShareOfRetail: number;
  stakerShareOfHolders: number;
  averageStakedPerStaker: number;
};

export type ChainOverlapStats = {
  chainKeys: string[];
  chainCounts: Record<string, number>;
  uniqueCount: number;
  multiChainCount: number;
  multiChainShare: number;
};

const getBalanceValue = (holder: HolderEntry) =>
  holder.totalBalance ?? holder.balance ?? 0;

const calculatePercentile = (values: number[], percentile: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const calculateGini = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;

  let weightedSum = 0;
  const n = sorted.length;
  for (let i = 0; i < n; i += 1) {
    weightedSum += (n - i) * sorted[i];
  }

  return (n + 1 - (2 * weightedSum) / total) / n;
};

const MIN_TEL_BALANCE_INSIGHTS = 1;

const DISTRIBUTION_RANGES: { label: string; min: number; max: number }[] = [
  { label: "1–100", min: 1, max: 100 },
  { label: "100–1K", min: 100, max: 1_000 },
  { label: "1K–10K", min: 1_000, max: 10_000 },
  { label: "10K–100K", min: 10_000, max: 100_000 },
  { label: "100K–1M", min: 100_000, max: 1_000_000 },
  { label: "1M–10M", min: 1_000_000, max: 10_000_000 },
  { label: "10M+", min: 10_000_000, max: Number.POSITIVE_INFINITY },
];

export const getBalanceStats = (holders: HolderEntry[]): BalanceStats => {
  const balances = holders
    .map(getBalanceValue)
    .filter((value) => Number.isFinite(value) && value >= MIN_TEL_BALANCE_INSIGHTS);

  const total = balances.reduce((sum, value) => sum + value, 0);
  const count = balances.length;
  const average = count > 0 ? total / count : 0;

  const distributionBuckets: DistributionBucket[] = DISTRIBUTION_RANGES.map((range) => ({
    rangeLabel: range.label,
    count: balances.filter((b) => b >= range.min && b < range.max).length,
  }));

  const averageRange =
    DISTRIBUTION_RANGES.find((r) => average >= r.min && average < r.max)?.label ??
    DISTRIBUTION_RANGES[DISTRIBUTION_RANGES.length - 1]!.label;

  return {
    count,
    total,
    average,
    median: calculatePercentile(balances, 50),
    p50: calculatePercentile(balances, 50),
    p75: calculatePercentile(balances, 75),
    p90: calculatePercentile(balances, 90),
    p99: calculatePercentile(balances, 99),
    gini: calculateGini(balances),
    distributionBuckets,
    averageRangeLabel: averageRange,
  };
};

export type StakingDistribution = {
  distributionBuckets: DistributionBucket[];
  averageStakedRangeLabel: string;
};

export const getStakingStats = (holders: HolderEntry[], retailSupply: number): StakingStats => {
  const stakers = holders.filter((holder) => (holder.stakedBalance ?? 0) > 0);
  const stakedTotal = stakers.reduce((sum, holder) => sum + (holder.stakedBalance ?? 0), 0);
  const stakerCount = stakers.length;
  const holderCount = holders.length;

  return {
    stakerCount,
    holderCount,
    stakedTotal,
    stakedShareOfRetail: retailSupply > 0 ? stakedTotal / retailSupply : 0,
    stakerShareOfHolders: holderCount > 0 ? stakerCount / holderCount : 0,
    averageStakedPerStaker: stakerCount > 0 ? stakedTotal / stakerCount : 0,
  };
};

export const getStakingDistribution = (holders: HolderEntry[]): StakingDistribution | null => {
  const stakedAmounts = holders
    .map((h) => h.stakedBalance ?? 0)
    .filter((v) => Number.isFinite(v) && v > 0);
  if (stakedAmounts.length === 0) return null;

  const distributionBuckets: DistributionBucket[] = DISTRIBUTION_RANGES.map((range) => ({
    rangeLabel: range.label,
    count: stakedAmounts.filter((b) => b >= range.min && b < range.max).length,
  }));

  const totalStaked = stakedAmounts.reduce((s, v) => s + v, 0);
  const averageStaked = totalStaked / stakedAmounts.length;
  const averageStakedRangeLabel =
    DISTRIBUTION_RANGES.find((r) => averageStaked >= r.min && averageStaked < r.max)?.label ??
    DISTRIBUTION_RANGES[DISTRIBUTION_RANGES.length - 1]!.label;

  return { distributionBuckets, averageStakedRangeLabel };
};

export const getChainOverlapStats = (
  snapshot: HolderSnapshotBase | null | undefined,
): ChainOverlapStats | null => {
  if (!snapshot) return null;

  const chainKeys = (snapshot.chainOrder?.length ? snapshot.chainOrder : Object.keys(snapshot.chains))
    .filter((key) => key !== "staking");

  const chainCounts: Record<string, number> = {};
  const holderChains = new Map<string, Set<string>>();

  for (const chainKey of chainKeys) {
    const holders = snapshot.chains[chainKey]?.holders ?? [];
    chainCounts[chainKey] = holders.length;

    for (const holder of holders) {
      const address = holder.address?.trim().toLowerCase();
      if (!address) continue;
      // Hold the Set directly rather than re-reading through get(): a
      // preceding has() check does not narrow Map.get()'s return type, and
      // the non-null assertion it would otherwise need is exactly the escape
      // hatch strictNullChecks exists to remove.
      let chains = holderChains.get(address);
      if (!chains) {
        chains = new Set();
        holderChains.set(address, chains);
      }
      chains.add(chainKey);
    }
  }

  let multiChainCount = 0;
  for (const chains of holderChains.values()) {
    if (chains.size > 1) {
      multiChainCount += 1;
    }
  }

  const uniqueCount = holderChains.size;
  const multiChainShare = uniqueCount > 0 ? multiChainCount / uniqueCount : 0;

  return {
    chainKeys,
    chainCounts,
    uniqueCount,
    multiChainCount,
    multiChainShare,
  };
};
