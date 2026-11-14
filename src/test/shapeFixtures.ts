/**
 * Synthetic project shapes and the stub feeds for them.
 *
 * `buildFeeds(project)` returns every feed file the UI fetches, in the shape its
 * hook expects, with all labels, categories and chains taken from the project's
 * own config. Values scale from `supply.target`; nothing is copied from
 * public/data. The same builder serves the registered configs (tel, zebec,
 * ondo) and the synthetic ones, so a new token's shape is proven the same way.
 */
import { holderTiersFor } from "@/lib/holderTiers";
import type { ProjectConfig } from "@/lib/projects";

export type Feeds = Record<string, unknown>;

const evmChain = (key: string, name: string, chainId: number, explorer: string, origin: boolean, address: string, over: Record<string, unknown> = {}) => ({
  key,
  name,
  vm: "evm" as const,
  chainId,
  origin,
  explorer,
  tokens: [{ address, decimals: 18, status: "canonical" }],
  ...over,
});

const addr = (hex: string) => `0x${hex.repeat(20)}`;

export const SHAPE_A_TINY = {
  slug: "shape-tiny",
  name: "Tinycoin",
  ticker: "TNY",
  description: "Synthetic tiny shape.",
  supply: {
    target: 1_000_000,
    targetLabel: "1M",
    circulating: { subtract: ["treasury"] },
    developerHoldings: { subcategories: [{ category: "treasury", label: "Tiny reserve" }] },
  },
  chains: [
    {
      ...evmChain("base", "Base", 8453, "https://basescan.org", true, addr("ab")),
      tokens: [{ address: addr("ab"), decimals: 0, status: "canonical" }],
    },
  ],
  holders: {
    retailThreshold: 100,
    megaHolderThreshold: 200_000,
    concentrationBuckets: [10, 25, 50, 100, 250, 500, 1000],
    balanceRanges: [
      { label: "1–100", min: 1, max: 100 },
      { label: "100+", min: 100, max: null },
    ],
    distributionTiers: [
      { label: "10K+", min: 10_000, max: null },
      { label: "1K-10K", min: 1_000, max: 10_000 },
      { label: "1-1K", min: 1, max: 1_000 },
    ],
  },
  treasury: { categories: ["treasury"] },
} as unknown as ProjectConfig;

const HUGE_BOUNDS = [500e9, 250e9, 100e9, 50e9, 25e9, 10e9, 5e9, 1e9, 500e6, 100e6, 10e6, 1e6, 1e3, 1];
const hugeTierLabel = (n: number) => (n >= 1e9 ? `${n / 1e9}B` : n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : `${n}`);
const HUGE_TIERS = HUGE_BOUNDS.map((min, i) => {
  const max = i === 0 ? null : HUGE_BOUNDS[i - 1];
  return { label: max === null ? `${hugeTierLabel(min)}+` : `${hugeTierLabel(min)}-${hugeTierLabel(max)}`, min, max };
});
const HUGE_RANGES = [
  { label: "1–1K", min: 1, max: 1e3 },
  { label: "1K–100K", min: 1e3, max: 1e5 },
  { label: "100K–10M", min: 1e5, max: 1e7 },
  { label: "10M–100M", min: 1e7, max: 1e8 },
  { label: "100M–1B", min: 1e8, max: 1e9 },
  { label: "1B–10B", min: 1e9, max: 1e10 },
  { label: "10B–100B", min: 1e10, max: 1e11 },
  { label: "100B+", min: 1e11, max: null },
];

export const SHAPE_B_HUGE = {
  slug: "shape-huge",
  name: "Hugecoin",
  ticker: "HUGE",
  description: "Synthetic huge multi-chain shape.",
  supply: {
    target: 1_000_000_000_000,
    targetLabel: "1T",
    circulating: { subtract: ["treasury"] },
    developerHoldings: {
      subcategories: [
        { category: "treasury", label: "Huge treasury" },
        { category: "team", label: "Huge team wallets" },
        { category: "staking", label: "Huge reward vaults" },
      ],
    },
  },
  chains: [
    evmChain("ethereum", "Ethereum", 1, "https://etherscan.io", true, addr("e1")),
    evmChain("arbitrum", "Arbitrum", 42161, "https://arbiscan.io", false, addr("a2"), { bridge: "lock-mint" }),
    evmChain("optimism", "Optimism", 10, "https://optimistic.etherscan.io", false, addr("c3"), { bridge: "lock-mint" }),
    evmChain("bnb", "BNB Chain", 56, "https://bscscan.com", false, addr("d4"), { bridge: "lock-mint" }),
  ],
  staking: [{ chain: "ethereum", address: addr("5a"), name: "Huge staking vault", kind: "stakeChanged" }],
  holders: {
    retailThreshold: 1000,
    megaHolderThreshold: 200_000_000_000,
    concentrationBuckets: [10, 100, 1000],
    balanceRanges: HUGE_RANGES,
    distributionTiers: HUGE_TIERS,
  },
  treasury: { categories: ["treasury", "team", "staking"] },
} as unknown as ProjectConfig;

export const SHAPE_C_HEDERA = {
  slug: "shape-hedera",
  name: "Hederacoin",
  ticker: "HBC",
  description: "Synthetic Hedera native coin shape.",
  supply: {
    target: 50_000_000_000,
    targetLabel: "50B",
    circulating: { subtract: ["treasury"] },
    developerHoldings: { subcategories: [{ category: "treasury", label: "Hedera treasury" }] },
  },
  chains: [
    {
      key: "hedera",
      name: "Hedera",
      vm: "hedera",
      origin: true,
      tokens: [{ address: "0.0.123456", decimals: 8, status: "canonical" }],
    },
  ],
  holders: {
    retailThreshold: 1000,
    megaHolderThreshold: 10_000_000_000,
    concentrationBuckets: [10, 100, 1000],
    balanceRanges: [
      { label: "1–1K", min: 1, max: 1_000 },
      { label: "1K–1M", min: 1_000, max: 1_000_000 },
      { label: "1M+", min: 1_000_000, max: null },
    ],
    distributionTiers: [
      { label: "1B+", min: 1e9, max: null },
      { label: "10M-1B", min: 1e7, max: 1e9 },
      { label: "1-10M", min: 1, max: 1e7 },
    ],
  },
  treasury: { categories: ["treasury"] },
} as unknown as ProjectConfig;

export const SHAPE_D_SOLANA_STAKING = {
  slug: "shape-solstake",
  name: "Solstake",
  ticker: "SLS",
  description: "Synthetic Solana staking shape.",
  supply: {
    target: 5_000_000_000,
    targetLabel: "5B",
    circulating: { subtract: [] },
    developerHoldings: {
      subcategories: [
        { category: "team", label: "Solstake team wallets" },
        { category: "staking", label: "Solstake reward vaults" },
      ],
    },
  },
  chains: [
    {
      key: "solana",
      name: "Solana",
      vm: "solana",
      cluster: "mainnet-beta",
      origin: true,
      explorer: "https://solscan.io",
      tokens: [{ address: "SLSmintAbCdEfGhJkLmNpQrStUvWxYz123456789ab", decimals: 6, program: "spl-token" }],
    },
  ],
  staking: [{ chain: "solana", address: "SLSstakeAbCdEfGhJkLmNpQrStUvWxYz12345678abc", name: "Solstake staking program", kind: "zebecStakeV1" }],
  holders: {
    retailThreshold: 1000,
    megaHolderThreshold: 1_000_000_000,
    concentrationBuckets: [10, 100, 1000],
    balanceRanges: [
      { label: "1–1K", min: 1, max: 1_000 },
      { label: "1K–100K", min: 1_000, max: 100_000 },
      { label: "100K+", min: 100_000, max: null },
    ],
    distributionTiers: [
      { label: "100M+", min: 1e8, max: null },
      { label: "1M-100M", min: 1e6, max: 1e8 },
      { label: "1-1M", min: 1, max: 1e6 },
    ],
  },
  treasury: { categories: ["team", "staking"] },
} as unknown as ProjectConfig;

export const SYNTHETIC_SHAPES = [SHAPE_A_TINY, SHAPE_B_HUGE, SHAPE_C_HEDERA, SHAPE_D_SOLANA_STAKING] as const;

// ---------------------------------------------------------------------------

export const EXCHANGES = ["Alpha Exchange", "Beta Exchange"];

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 40;
/** Pipeline default when a project's treasury.categories is absent (TEL's four). */
const DEFAULT_TREASURY_CATEGORIES = ["treasury", "council", "holdings", "escrow"];

export const treasuryCategoriesOf = (p: ProjectConfig): string[] => p.treasury?.categories ?? DEFAULT_TREASURY_CATEGORIES;

const isoDay = (offsetDays: number, now: number) => new Date(now - offsetDays * DAY_MS).toISOString().slice(0, 10);

const roundTo = (v: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

export const holderCountOf = (p: ProjectConfig): number => ((p.supply?.target ?? 0) <= 1_000_000 ? 300 : 40_000);

/** Per-tier counts/balances: more wallets in small tiers, most balance in large ones, summing to ~60% of supply. */
const tierRows = (p: ProjectConfig, scale: number) => {
  const tiers = holderTiersFor(p).distributionTiers;
  const holders = holderCountOf(p);
  const supply = p.supply?.target ?? 1e9;
  const weights = tiers.map((_, i) => 1.8 ** i);
  const wSum = weights.reduce((a, b) => a + b, 0);
  const mids = tiers.map((t) => (Number.isFinite(t.max) ? Math.sqrt(t.min * t.max) : t.min * 2));
  const rawBal = tiers.map((_, i) => Math.max(1, Math.floor((holders * weights[i]) / wSum)) * mids[i]);
  const balSum = rawBal.reduce((a, b) => a + b, 0);
  return tiers.map((t, i) => {
    const count = Math.max(1, Math.floor((holders * weights[i]) / wSum));
    const totalBalance = roundTo((rawBal[i] / balSum) * supply * 0.6 * scale, 2);
    return { label: t.label, count: Math.round(count * scale), totalBalance };
  });
};

const withPercent = (rows: ReturnType<typeof tierRows>, prev: ReturnType<typeof tierRows>) => {
  const total = rows.reduce((a, r) => a + r.totalBalance, 0) || 1;
  const prevTotal = prev.reduce((a, r) => a + r.totalBalance, 0) || 1;
  return rows.map((r, i) => ({
    label: r.label,
    count: r.count,
    totalBalance: r.totalBalance,
    percent: roundTo((r.totalBalance / total) * 100, 2),
    previousCount: prev[i].count,
    previousTotalBalance: prev[i].totalBalance,
    previousPercent: roundTo((prev[i].totalBalance / prevTotal) * 100, 2),
  }));
};

const metricsFor = (p: ProjectConfig, share: number, scale: number, staked: number) => {
  const supply = p.supply?.target ?? 1e9;
  const holders = Math.round(holderCountOf(p) * share * scale);
  const retailBalance = roundTo(supply * 0.45 * share * scale, 2);
  const out: Record<string, unknown> = {
    holderCount: holders,
    totalBalance: roundTo(supply * 0.6 * share * scale, 2),
    retail: { count: Math.round(holders * 0.9), balance: retailBalance },
    underThreshold: { count: Math.round(holders * 0.08), balance: roundTo(supply * 0.01 * share, 2) },
    mega: { count: 1, balance: roundTo(supply * 0.1 * share, 2) },
    excluded: { count: 3, balance: roundTo(supply * 0.2 * share, 2) },
  };
  if (staked > 0) out.holderCountWithStakers = holders;
  return out;
};

const balanceStatsFor = (p: ProjectConfig, share: number) => {
  const ranges = holderTiersFor(p).balanceRanges;
  const holders = Math.round(holderCountOf(p) * share);
  const supply = p.supply?.target ?? 1e9;
  const total = supply * 0.4 * share;
  const average = total / holders;
  const avgRange = ranges.find((r) => average >= r.min && average < r.max)?.label ?? ranges[ranges.length - 1].label;
  const per = Math.floor(holders / ranges.length);
  return {
    count: holders,
    total,
    average,
    median: average * 0.2,
    p50: average * 0.2,
    p75: average * 0.6,
    p90: average * 2,
    p99: average * 20,
    gini: 0.82,
    distributionBuckets: ranges.map((r) => ({ rangeLabel: r.label, count: per })),
    averageRangeLabel: avgRange,
  };
};

const concentrationFor = (p: ProjectConfig, share: number, scale: number) => {
  const supply = p.supply?.target ?? 1e9;
  const holders = holderCountOf(p);
  const buckets = holderTiersFor(p).concentrationBuckets;
  const top: Record<string, number> = {};
  buckets.forEach((n, i) => {
    // Cumulative share of retail balance: a bucket covering every holder is 100%.
    const covered = n >= holders ? 1 : 0.2 + 0.6 * ((i + 1) / buckets.length);
    top[String(n)] = roundTo(supply * 0.45 * share * scale * covered * 0.5, 2);
  });
  return top;
};

const stakingStatsFor = (p: ProjectConfig, share: number) => {
  const supply = p.supply?.target ?? 1e9;
  const holders = Math.round(holderCountOf(p) * share);
  const stakedTotal = roundTo(supply * 0.04 * share, 2);
  const stakers = Math.max(1, Math.round(holders * 0.1));
  const base = {
    stakerCount: stakers,
    holderCount: holders,
    stakedTotal,
    stakedShareOfRetail: 0.09,
    stakerShareOfHolders: 0.1,
    averageStakedPerStaker: stakedTotal / stakers,
  };
  const gens = new Set((p.staking ?? []).map((s) => s.token));
  if (gens.has("legacy") && gens.has("v3")) {
    return {
      ...base,
      legacy: { stakerCount: Math.round(stakers * 0.4), stakedTotal: roundTo(stakedTotal * 0.4, 2) },
      v3: { stakerCount: Math.round(stakers * 0.6), stakedTotal: roundTo(stakedTotal * 0.6, 2), deployDate: isoDay(20, Date.now()), deployBlock: 1, module: p.staking![1].address },
      stakedInBoth: 0,
    };
  }
  return base;
};

const stakingDistributionFor = (p: ProjectConfig) => {
  const ranges = holderTiersFor(p).balanceRanges;
  return { distributionBuckets: ranges.map((r) => ({ rangeLabel: r.label, count: 2 })), averageStakedRangeLabel: ranges[0].label };
};

/** A syntactically valid address for the project's origin chain (EVM hex, Hedera 0.0.N or Solana base58 with capitals). */
export const addressFor = (p: ProjectConfig, i: number): string => {
  const origin = p.chains.find((c) => c.origin) ?? p.chains[0];
  if (origin.vm === "hedera") return `0.0.${900000 + i}`;
  if (origin.vm === "solana" || origin.key === "solana") return `Wa11etAbCdEfGhJkLmNpQrStUvWxYz${String(i).padStart(3, "0")}Qq${"R".repeat(8)}`.slice(0, 44);
  return `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`;
};

type BuildOptions = { now?: number; cexBalance?: number };

const buildCex = (p: ProjectConfig, balance: number) => {
  const totals = (name: string, share: number, i: number) => ({
    name,
    walletCount: 1,
    walletCountWithBalance: 1,
    previousWalletCountWithBalance: 1,
    currentBalance: balance * share,
    previousBalance: balance * share * 0.5,
    inflow: balance * share * 0.1,
    outflow: balance * share * 0.05,
    net: balance * share * 0.05,
    wallets: [{ address: addressFor(p, 50 + i), walletName: `${name} hot`, currentBalance: balance * share, previousBalance: balance * share * 0.5 }],
  });
  return {
    generatedAt: new Date().toISOString(),
    overall: {
      walletCount: 2,
      walletCountWithBalance: 2,
      previousWalletCountWithBalance: 2,
      currentBalance: balance,
      previousBalance: balance * 0.5,
      inflow: balance * 0.1,
      outflow: balance * 0.05,
      net: balance * 0.05,
    },
    exchanges: [totals(EXCHANGES[0], 0.6, 0), totals(EXCHANGES[1], 0.4, 1)],
  };
};

/** Network staking figure (informational) the way the pipeline's `stakingInfo` port writes it: native-coin chains only. */
export const hasNetworkStake = (p: ProjectConfig): boolean => p.chains.some((c) => c.vm === "hedera");
export const NETWORK_STAKE_SHARE = 0.27;

const buildNetworkStake = (p: ProjectConfig, now: number) => {
  const start = new Date(Math.floor(now / DAY_MS) * DAY_MS);
  return {
    chainKey: p.chains.find((c) => c.vm === "hedera")?.key,
    available: true,
    stakedTotal: roundTo((p.supply?.target ?? 1e9) * NETWORK_STAKE_SHARE, 2),
    decimals: 8,
    stakingPeriod: { start: start.toISOString(), end: new Date(start.getTime() + DAY_MS).toISOString() },
    source: "mirror node /network/stake",
  };
};

const buildLite = (p: ProjectConfig, now: number, cexBalance?: number) => {
  const hasStaking = (p.staking?.length ?? 0) > 0;
  const supply = p.supply?.target ?? 1e9;
  const chainKeys = p.chains.map((c) => c.key);
  const cur = tierRows(p, 1);
  const prev = tierRows(p, 0.97);
  const view = (key: string, label: string, share: number) => ({
    key,
    label,
    metrics: metricsFor(p, share, 1, hasStaking ? 1 : 0),
    previousMetrics: metricsFor(p, share, 0.97, hasStaking ? 1 : 0),
    concentration: { top: concentrationFor(p, share, 1), previousTop: concentrationFor(p, share, 0.97) },
    balanceStats: balanceStatsFor(p, share),
    stakingStats: hasStaking
      ? stakingStatsFor(p, share)
      : { stakerCount: 0, holderCount: Math.round(holderCountOf(p) * share), stakedTotal: 0, stakedShareOfRetail: 0, stakerShareOfHolders: 0, averageStakedPerStaker: 0 },
    stakingDistribution: hasStaking ? stakingDistributionFor(p) : null,
    distribution: withPercent(cur.map((r) => ({ ...r, count: Math.round(r.count * share), totalBalance: r.totalBalance * share })), prev.map((r) => ({ ...r, count: Math.round(r.count * share), totalBalance: r.totalBalance * share }))),
    velocity: null,
  });
  const views: Record<string, unknown> = { combined: view("combined", "All chains", 1) };
  chainKeys.forEach((k, i) => {
    views[k] = view(k, p.chains[i].name, chainKeys.length === 1 ? 1 : 1 / chainKeys.length);
  });
  const chainCounts = Object.fromEntries(chainKeys.map((k) => [k, Math.round(holderCountOf(p) / chainKeys.length)]));
  return {
    generatedAt: new Date(now - 3_600_000).toISOString(),
    thresholds: { retail: holderTiersFor(p).retailThreshold, megaHolder: holderTiersFor(p).megaHolderThreshold },
    totals: { totalSupply: supply },
    source: null,
    chainOrder: chainKeys,
    views,
    overlap: chainKeys.length > 1
      ? { chainKeys, chainCounts, uniqueCount: holderCountOf(p), multiChainCount: 5, multiChainShare: 0.001 }
      : null,
    cex: buildCex(p, cexBalance ?? supply * 0.05),
    ...(hasNetworkStake(p) ? { networkStake: buildNetworkStake(p, now) } : {}),
  };
};

const buildHistory = (p: ProjectConfig, now: number) => {
  const hasStaking = (p.staking?.length ?? 0) > 0;
  const gens = new Set((p.staking ?? []).map((s) => s.token));
  const hasGenerations = gens.has("legacy") && gens.has("v3");
  const supply = p.supply?.target ?? 1e9;
  const holders = holderCountOf(p);
  const tiers = holderTiersFor(p).distributionTiers;
  const entries = Array.from({ length: HISTORY_DAYS }, (_, i) => {
    const age = HISTORY_DAYS - 1 - i;
    const grow = 1 - age * 0.002;
    const date = isoDay(age, now);
    const combined: Record<string, unknown> = {
      holderCount: Math.round(holders * grow),
      retailHolderCount: Math.round(holders * 0.9 * grow),
      totalBalance: roundTo(supply * 0.45 * grow, 2),
      totalHeld: roundTo(supply * 0.5 * grow, 2),
      dexLiquidity: roundTo(supply * 0.02, 2),
      cexBalance: roundTo(supply * 0.05 * grow, 2),
    };
    if (hasStaking) {
      const staked = roundTo(supply * 0.04 * grow, 2);
      if (hasGenerations) {
        combined.stakingBalance = roundTo(staked * 0.4, 2);
        combined.stakingV3Balance = roundTo(staked * 0.6, 2);
      } else {
        combined.stakingV3Balance = staked;
      }
      combined.holderCountWithStakers = Math.round(holders * grow);
    }
    const buckets = holderTiersFor(p).concentrationBuckets;
    return {
      date,
      generatedAt: `${date}T06:00:00.000Z`,
      combined,
      concentration: Object.fromEntries(buckets.map((n) => [String(n), roundTo(supply * 0.2 * grow, 2)])),
      distribution: tiers.map((t, j) => ({ label: t.label, count: Math.round((holders / tiers.length) * grow) + j, totalBalance: roundTo((supply * 0.05 * grow) / (j + 1), 2) })),
      cumulativeHolders: Math.round(holders * 1.2 * grow),
      chains: Object.fromEntries(
        p.chains.map((c) => [c.key, { holderCount: Math.round((holders * grow) / p.chains.length), retailHolderCount: Math.round((holders * 0.9 * grow) / p.chains.length), totalBalance: roundTo((supply * 0.45 * grow) / p.chains.length, 2) }]),
      ),
    };
  });
  return { generatedAt: new Date(now).toISOString(), entries };
};

const WINDOWS = ["1", "7", "30", "90", "365", "ytd"];

const buildTransitions = (p: ProjectConfig, now: number) => {
  const labels = holderTiersFor(p).distributionTiers.map((t) => t.label);
  const supply = p.supply?.target ?? 1e9;
  const matrix = Object.fromEntries(
    labels.map((from, i) => [
      from,
      Object.fromEntries(labels.map((to, j) => [to, { count: i === j ? 40 : Math.abs(i - j) === 1 ? 3 : 0, tel: i === j ? 0 : roundTo(supply * 0.0001, 2) }])),
    ]),
  );
  return {
    generatedAt: new Date(now).toISOString(),
    latestDate: isoDay(0, now),
    ranges: Object.fromEntries(WINDOWS.map((w) => [w, { from: isoDay(30, now), to: isoDay(0, now), matrix }])),
  };
};

const buildOutflows = (p: ProjectConfig, now: number) => {
  const labels = holderTiersFor(p).distributionTiers.map((t) => t.label);
  const supply = p.supply?.target ?? 1e9;
  const chainKeys = p.chains.map((c) => c.key);
  const cell = (i: number) => ({
    dex: roundTo(supply * 0.0002 * (i + 1), 2),
    cex: roundTo(supply * 0.0001 * (i + 1), 2),
    moved: roundTo(supply * 0.0003 * (i + 1), 2),
    inflows: { dex: roundTo(supply * 0.0001, 2), cex: roundTo(supply * 0.00005, 2), wallet: roundTo(supply * 0.0002, 2) },
    byChain: Object.fromEntries(chainKeys.map((k) => [k, { dex: 1, cex: 1, moved: 1, inflows: { dex: 1, cex: 1, wallet: 1 } }])),
  });
  return {
    schema: 11,
    generatedAt: new Date(now).toISOString(),
    complete: true,
    latestDate: isoDay(0, now),
    ranges: Object.fromEntries(WINDOWS.map((w) => [w, { from: isoDay(30, now), to: isoDay(0, now), tiers: Object.fromEntries(labels.map((l, i) => [l, cell(i)])) }])),
  };
};

const buildExchangeFlow = (p: ProjectConfig, now: number) => {
  const supply = p.supply?.target ?? 1e9;
  const chainKeys = p.chains.map((c) => c.key);
  return {
    generatedAt: new Date(now).toISOString(),
    entries: Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const inn = roundTo(supply * 0.0004 * (1 + (i % 3)), 2);
      const out = roundTo(supply * 0.0003 * (1 + (i % 2)), 2);
      return {
        date: isoDay(HISTORY_DAYS - 1 - i, now),
        in: inn,
        out,
        net: roundTo(inn - out, 2),
        dexIn: roundTo(inn * 0.2, 2),
        dexOut: roundTo(out * 0.2, 2),
        dexNet: roundTo((inn - out) * 0.2, 2),
        chains: Object.fromEntries(chainKeys.map((k) => [k, { in: roundTo(inn / chainKeys.length, 2), out: roundTo(out / chainKeys.length, 2) }])),
      };
    }),
  };
};

const buildCexHistory = (p: ProjectConfig, now: number) => {
  const supply = p.supply?.target ?? 1e9;
  return {
    generatedAt: new Date(now).toISOString(),
    entries: Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const a = roundTo(supply * 0.03 * (1 + i * 0.001), 2);
      const b = roundTo(supply * 0.02, 2);
      return { date: isoDay(HISTORY_DAYS - 1 - i, now), exchanges: { [EXCHANGES[0]]: a, [EXCHANGES[1]]: b }, total: roundTo(a + b, 2) };
    }),
  };
};

/** Category balances that partition `supply.target` exactly (parts summing to supply, bridge legs netted out). */
export const reconCategories = (p: ProjectConfig): { categories: Record<string, number>; devKeys: string[] } => {
  const supply = p.supply?.target ?? 1e9;
  const devKeys = (p.supply?.developerHoldings?.subcategories ?? []).map((s) => s.category);
  const categories: Record<string, number> = {};
  const devShare = 0.1 / Math.max(1, devKeys.length);
  devKeys.forEach((k) => { categories[k] = roundTo(supply * devShare, 2); });
  categories.dex = roundTo(supply * 0.03, 2);
  categories.cex = roundTo(supply * 0.07, 2);
  categories.burn = roundTo(supply * 0.01, 2);
  const others = Object.values(categories).reduce((a, b) => a + b, 0);
  categories.retail = roundTo(supply - others, 2);
  return { categories, devKeys };
};

/** Bridge legs exist only when supply is mirrored across several chains. */
const bridged = (p: ProjectConfig) => p.chains.length > 1;

const buildRecon = (p: ProjectConfig) => {
  const supply = p.supply?.target ?? 1e9;
  const { categories, devKeys } = reconCategories(p);
  const sampleAddr = (_k: string, i: number) => addressFor(p, i);
  const items = Object.entries(categories).map(([category, balance], i) => ({
    address: sampleAddr(category, i),
    category,
    name: `${category} wallet`,
    balance,
    counted: true,
  }));
  const bridgeLocked = bridged(p) ? roundTo(supply * 0.05, 2) : 0;
  const mirrored = bridgeLocked;
  if (bridgeLocked > 0) {
    items.push({ address: sampleAddr("bridge", 99), category: "bridge-lock", name: "Bridge lock vault", balance: bridgeLocked, counted: false });
  }
  const counted = Object.values(categories).reduce((a, b) => a + b, 0);
  const subtract = p.supply?.circulating?.subtract ?? ["treasury", "council"];
  const circulating = counted - subtract.reduce((a, k) => a + (categories[k] ?? 0), 0);
  const upgrade = p.supply?.upgrade
    ? {
        retiredLegacy: roundTo(supply * 0.2, 2),
        retiredLegacyByChain: { [p.chains[0].key]: roundTo(supply * 0.2, 2) },
        v3Supply: roundTo(supply * 0.2, 2),
        v3SupplyByChain: { [p.chains[0].key]: roundTo(supply * 0.2, 2) },
        legacySupplyByChain: { [p.chains[0].key]: roundTo(supply * 0.8, 2) },
        strandedInUpgrade: roundTo(supply * 0.001, 2),
        strandedInUpgradeByChain: { [p.chains[0].key]: roundTo(supply * 0.001, 2) },
      }
    : undefined;
  return {
    totalSupply: supply,
    derivedOriginTotal: supply,
    bridgeLocked,
    mirrored,
    mirrorResidual: 0,
    residual: roundTo(supply - counted, 2),
    residualParts: { bridgeInFlight: 0, originDrift: 0 },
    ...(upgrade ? { upgrade } : {}),
    categories,
    counted,
    circulating,
    circulatingExclusions: { total: 0, items: [] },
    warnings: [],
    coingeckoCirculating: null,
    items: devKeys.length ? items : items,
  };
};

const buildTreasury = (p: ProjectConfig, now: number) => {
  const supply = p.supply?.target ?? 1e9;
  const cats = treasuryCategoriesOf(p);
  return {
    generatedAt: new Date(now).toISOString(),
    source: { method: "transfer-logs", categories: cats, addressCount: cats.length, excludes: "none", anchorDate: isoDay(HISTORY_DAYS - 1, now) },
    latestByAddress: {},
    entries: Array.from({ length: HISTORY_DAYS }, (_, i) => ({
      date: isoDay(HISTORY_DAYS - 1 - i, now),
      categories: Object.fromEntries(cats.map((c, j) => [c, roundTo(supply * 0.02 * (j + 1) * (1 - i * 0.003), 2)])),
    })),
  };
};

const buildChainStatus = (p: ProjectConfig, now: number) => ({
  generatedAt: new Date(now).toISOString(),
  chains: Object.fromEntries(
    p.chains.map((c, i) => [c.key, { lastBlock: 1_000_000 + i, scannedAt: new Date(now - 60_000).toISOString(), ...(c.vm === "solana" ? { vm: "solana" } : {}) }]),
  ),
});

const buildChangelog = (now: number) => ({ schemaVersion: 1, generatedAt: new Date(now).toISOString(), events: [] });

/** Every feed file the app fetches for `project`, keyed by file name. */
export const buildFeeds = (project: ProjectConfig, { now = Date.now(), cexBalance }: BuildOptions = {}): Feeds => ({
  "holders-lite.json": buildLite(project, now, cexBalance),
  "holders-history.json": buildHistory(project, now),
  "holder-transitions.json": buildTransitions(project, now),
  "tier-outflows.json": buildOutflows(project, now),
  "exchange-flow-history.json": buildExchangeFlow(project, now),
  "cex-balance-history.json": buildCexHistory(project, now),
  "supply-reconciliation.json": buildRecon(project),
  "treasury-history.json": buildTreasury(project, now),
  "chain-status.json": buildChainStatus(project, now),
  "classification-changelog.json": buildChangelog(now),
});
