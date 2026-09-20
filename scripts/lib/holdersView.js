import { buildChainHolders, buildMetrics, applyStaking } from "./stakingAttribution.js";
import { reconcileDistributionCounts } from "./holderHistoryReconcile.js";

export const CONCENTRATION_BUCKETS = [10, 25, 50, 100, 250, 500, 1000];

export const BALANCE_RANGES = [
  // Floor is 1 TEL, deliberately, by explicit product decision (2026-08-15):
  // sub-1-TEL dust wallets should not be counted in any breakdown/bucket,
  // even though metrics.holderCount and balanceStats.count still count them
  // (see buildBalanceStats' own >= 0 filter below). This means
  // sum(distributionBuckets.count) is intentionally LESS than
  // metrics.holderCount by the dust-wallet count — do not "fix" this by
  // lowering the floor back to 0 (that was tried and reverted; see
  // lessons.md "Sub-1-TEL Dust Wallets Are Deliberately Excluded From
  // Buckets, Not Counts"). The UI notes the gap where the breakdown is shown.
  { label: "1–100", min: 1, max: 100 },
  { label: "100–1K", min: 100, max: 1_000 },
  { label: "1K–10K", min: 1_000, max: 10_000 },
  { label: "10K–100K", min: 10_000, max: 100_000 },
  { label: "100K–1M", min: 100_000, max: 1_000_000 },
  { label: "1M–10M", min: 1_000_000, max: 10_000_000 },
  { label: "10M+", min: 10_000_000, max: Number.POSITIVE_INFINITY },
];

export const DISTRIBUTION_RANGES = [
  { label: "500M+", min: 500_000_000, max: Number.POSITIVE_INFINITY },
  { label: "250M-500M", min: 250_000_000, max: 500_000_000 },
  { label: "100M-250M", min: 100_000_000, max: 250_000_000 },
  { label: "50M-100M", min: 50_000_000, max: 100_000_000 },
  { label: "25M-50M", min: 25_000_000, max: 50_000_000 },
  { label: "10M-25M", min: 10_000_000, max: 25_000_000 },
  { label: "5M-10M", min: 5_000_000, max: 10_000_000 },
  { label: "1M-5M", min: 1_000_000, max: 5_000_000 },
  { label: "250K-1M", min: 250_000, max: 1_000_000 },
  // Floor 1 TEL, same deliberate decision as BALANCE_RANGES above. The label
  // string is a join key into holder-transitions.json's matrix and
  // tier-outflows.json, so it must not change even though its floor moves —
  // the UI renders a friendlier display label instead (see
  // TIER_DISPLAY_LABELS in tierflow/geometry.ts, which no longer needs to
  // fix up an inaccurate floor but is harmless to leave as-is).
  { label: "1-250K", min: 1, max: 250_000 },
];

export const normalizeAddress = (value) => {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
};

export const createEmptyMetrics = () => ({
  holderCount: 0,
  totalBalance: 0,
  retail: { count: 0, balance: 0 },
  underThreshold: { count: 0, balance: 0 },
  mega: { count: 0, balance: 0 },
  excluded: { count: 0, balance: 0 },
});

const calculatePercentile = (values, percentile) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const calculateGini = (values) => {
  if (!values.length) return 0;
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

export const buildBalanceStats = (holders) => {
  const balances = holders
    .map((holder) => holder.totalBalance ?? holder.balance ?? 0)
    // >= 0 (not >= 1) so sub-1-TEL dust holders are counted here too, keeping
    // balanceStats.count reconciled with metrics.holderCount.
    .filter((value) => Number.isFinite(value) && value >= 0);

  const total = balances.reduce((sum, value) => sum + value, 0);
  const count = balances.length;
  const average = count > 0 ? total / count : 0;

  const distributionBuckets = BALANCE_RANGES.map((range) => ({
    rangeLabel: range.label,
    count: balances.filter((b) => b >= range.min && b < range.max).length,
  }));

  const averageRangeLabel =
    BALANCE_RANGES.find((range) => average >= range.min && average < range.max)?.label ??
    BALANCE_RANGES[BALANCE_RANGES.length - 1].label;

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
    averageRangeLabel,
  };
};

export const buildStakingStats = (holders, retailSupply) => {
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

export const buildStakingDistribution = (holders) => {
  const stakedAmounts = holders
    .map((holder) => holder.stakedBalance ?? 0)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!stakedAmounts.length) return null;

  const distributionBuckets = BALANCE_RANGES.map((range) => ({
    rangeLabel: range.label,
    count: stakedAmounts.filter((b) => b >= range.min && b < range.max).length,
  }));

  const totalStaked = stakedAmounts.reduce((sum, value) => sum + value, 0);
  const averageStaked = totalStaked / stakedAmounts.length;
  const averageStakedRangeLabel =
    BALANCE_RANGES.find((range) => averageStaked >= range.min && averageStaked < range.max)?.label ??
    BALANCE_RANGES[BALANCE_RANGES.length - 1].label;

  return { distributionBuckets, averageStakedRangeLabel };
};

export const buildConcentration = (holders) => {
  const sorted = [...holders].sort(
    (a, b) => (b.totalBalance ?? b.balance ?? 0) - (a.totalBalance ?? a.balance ?? 0),
  );
  const top = {};
  for (const bucket of CONCENTRATION_BUCKETS) {
    const slice = sorted.slice(0, bucket);
    const total = slice.reduce((sum, holder) => sum + (holder.totalBalance ?? holder.balance ?? 0), 0);
    top[bucket] = total;
  }
  return { top };
};

export const buildDistributionRows = (holders, retailSupply, previousHolders, previousRetailSupply) =>
  DISTRIBUTION_RANGES.map((range) => {
    const bucket = holders.filter((holder) => {
      const value = holder.totalBalance ?? holder.balance ?? 0;
      return value >= range.min && value < range.max;
    });
    const totalBalance = bucket.reduce((sum, holder) => sum + (holder.totalBalance ?? holder.balance ?? 0), 0);
    const percent = retailSupply > 0 ? (totalBalance / retailSupply) * 100 : 0;

    const previousBucket = previousHolders.filter((holder) => {
      const value = holder.totalBalance ?? holder.balance ?? 0;
      return value >= range.min && value < range.max;
    });
    const previousTotalBalance = previousBucket.reduce(
      (sum, holder) => sum + (holder.totalBalance ?? holder.balance ?? 0),
      0,
    );
    const previousPercent = previousRetailSupply > 0 ? (previousTotalBalance / previousRetailSupply) * 100 : 0;

    return {
      label: range.label,
      count: bucket.length,
      totalBalance,
      percent,
      previousCount: previousBucket.length,
      previousTotalBalance,
      previousPercent,
    };
  }).filter((row) =>
    row.count > 0 ||
    row.totalBalance > 0 ||
    row.previousCount > 0 ||
    row.previousTotalBalance > 0,
  );

const buildHolderKeySet = (chains, selection) => {
  const keys = new Set();
  if (!chains) return keys;

  if (selection === "combined") {
    for (const chain of Object.values(chains)) {
      for (const holder of chain.holders ?? []) {
        const normalized = normalizeAddress(holder.address);
        if (!normalized) continue;
        keys.add(normalized);
      }
    }
    return keys;
  }

  const chain = chains[selection];
  if (!chain) return keys;
  for (const holder of chain.holders ?? []) {
    const normalized = normalizeAddress(holder.address);
    if (!normalized) continue;
    keys.add(normalized);
  }
  return keys;
};

export const computeVelocity = (current, previous, selection) => {
  if (!current || !previous) return null;
  const currentKeys = buildHolderKeySet(current.chains, selection);
  const previousKeys = buildHolderKeySet(previous.chains, selection);

  let added = 0;
  for (const key of currentKeys) {
    if (!previousKeys.has(key)) added += 1;
  }
  let removed = 0;
  for (const key of previousKeys) {
    if (!currentKeys.has(key)) removed += 1;
  }

  const net = added - removed;
  const currentDate = current.generatedAt ? new Date(current.generatedAt) : null;
  const previousDate = previous.generatedAt ? new Date(previous.generatedAt) : null;
  const diffMs =
    currentDate &&
    previousDate &&
    !Number.isNaN(currentDate.getTime()) &&
    !Number.isNaN(previousDate.getTime())
      ? currentDate.getTime() - previousDate.getTime()
      : 0;
  const days = diffMs > 0 ? diffMs / (1000 * 60 * 60 * 24) : 1;

  return {
    currentCount: currentKeys.size,
    previousCount: previousKeys.size,
    added,
    removed,
    net,
    days,
    addedPerDay: added / days,
    removedPerDay: removed / days,
    netPerDay: net / days,
  };
};

export const buildOverlapStats = (chains, chainOrder) => {
  if (!chains) return null;
  const chainKeys = (chainOrder?.length ? chainOrder : Object.keys(chains)).filter(
    (key) => key !== "staking",
  );
  const chainCounts = {};
  const holderChains = new Map();

  for (const chainKey of chainKeys) {
    const holders = chains[chainKey]?.holders ?? [];
    chainCounts[chainKey] = holders.length;
    for (const holder of holders) {
      const normalized = normalizeAddress(holder.address);
      if (!normalized) continue;
      if (!holderChains.has(normalized)) {
        holderChains.set(normalized, new Set());
      }
      holderChains.get(normalized).add(chainKey);
    }
  }

  let multiChainCount = 0;
  for (const set of holderChains.values()) {
    if (set.size > 1) multiChainCount += 1;
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

/** Builds enriched per-chain + combined metrics for one raw tel-holders.json snapshot. */
export const buildSnapshotData = (snapshot, fundingWallets, isNonRetailAddress) => {
  if (!snapshot) return null;
  const chains = applyStaking(buildChainHolders(snapshot, isNonRetailAddress), fundingWallets);
  const chainOrder = snapshot.chainOrder ?? Object.keys(chains);

  const enrichedChains = {};
  for (const [key, chain] of Object.entries(chains)) {
    const metrics = buildMetrics(chain.holders ?? []);
    enrichedChains[key] = {
      ...chain,
      metrics,
    };
  }

  const combinedHolders = Object.values(enrichedChains).flatMap((chain) => chain.holders ?? []);
  const combinedMetrics = buildMetrics(combinedHolders);

  return {
    generatedAt: snapshot.generatedAt ?? null,
    thresholds: snapshot.thresholds ?? { retail: 0, megaHolder: 0 },
    totals: snapshot.totals ?? { totalSupply: 0 },
    source: snapshot.source ?? null,
    chainOrder,
    chains: enrichedChains,
    combined: combinedMetrics,
  };
};

/** Builds one view's stats. Pass `previous: null` to compute current-side fields only. */
export const buildViewData = (selection, current, previous) => {
  const currentChains = current?.chains ?? {};
  const previousChains = previous?.chains ?? {};
  const currentHolders =
    selection === "combined"
      ? Object.values(currentChains).flatMap((chain) => chain.holders ?? [])
      : currentChains[selection]?.holders ?? [];
  const previousHolders =
    selection === "combined"
      ? Object.values(previousChains).flatMap((chain) => chain.holders ?? [])
      : previousChains[selection]?.holders ?? [];

  const currentMetrics = current
    ? selection === "combined"
      ? current.combined
      : currentChains[selection]?.metrics ?? createEmptyMetrics()
    : createEmptyMetrics();
  const previousMetrics = previous
    ? selection === "combined"
      ? previous.combined
      : previousChains[selection]?.metrics ?? createEmptyMetrics()
    : null;

  const concentration = buildConcentration(currentHolders);
  const previousConcentration = previous ? buildConcentration(previousHolders) : null;
  const balanceStats = buildBalanceStats(currentHolders);
  const stakingStats = buildStakingStats(currentHolders, currentMetrics.retail.balance ?? 0);
  const stakingDistribution = buildStakingDistribution(currentHolders);
  const rawDistribution = buildDistributionRows(
    currentHolders,
    currentMetrics.retail.balance ?? 0,
    previousHolders,
    previousMetrics?.retail?.balance ?? 0,
  );
  // DISTRIBUTION_RANGES floors at 1 TEL, deliberately excluding sub-1-TEL
  // dust wallets from every bucket — currentMetrics.holderCount/
  // previousMetrics.holderCount still count them, so Σcount would otherwise
  // run below holderCount by the dust-wallet count. Historical
  // holders-history.json entries already fold this gap into the lowest
  // bucket (reconcileHistoryEntry/reconcileDistributionCounts, scripts/lib/
  // holderHistoryReconcile.js) so Σcount === holderCount there; this
  // (current/"today") side never got the same treatment, so a caller
  // diffing this against a reconciled historical baseline (e.g.
  // DistributionAnalysisWidget's "net over YTD") was comparing two
  // different bases — reconciling both current and previous counts here
  // keeps every consumer of buildViewData on the same footing. Only
  // `count`/`previousCount` are folded — totalBalance/percent are untouched,
  // same as the historical reconcile (dust balance is <1 TEL each, ignored).
  const { distribution: reconciledCurrent } = reconcileDistributionCounts(
    currentMetrics.holderCount,
    rawDistribution.map((r) => ({ label: r.label, count: r.count })),
  );
  const currentByLabel = new Map(reconciledCurrent.map((r) => [r.label, r.count]));

  let previousByLabel = null;
  if (previousMetrics) {
    const { distribution: reconciledPrevious } = reconcileDistributionCounts(
      previousMetrics.holderCount,
      rawDistribution.map((r) => ({ label: r.label, count: r.previousCount ?? 0 })),
    );
    previousByLabel = new Map(reconciledPrevious.map((r) => [r.label, r.count]));
  }

  const distribution = rawDistribution.map((r) => ({
    ...r,
    count: currentByLabel.get(r.label) ?? r.count,
    previousCount: previousByLabel ? (previousByLabel.get(r.label) ?? r.previousCount) : r.previousCount,
  }));
  const velocity = computeVelocity(current, previous, selection);

  return {
    metrics: currentMetrics,
    previousMetrics,
    concentration: {
      top: concentration.top,
      previousTop: previousConcentration?.top ?? null,
    },
    balanceStats,
    stakingStats,
    stakingDistribution,
    distribution,
    velocity,
  };
};
