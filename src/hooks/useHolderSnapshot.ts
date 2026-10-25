import { useQuery } from "@tanstack/react-query";
import type {
  BalanceStats,
  StakingDistribution,
  StakingStats,
  ChainOverlapStats,
} from "@/lib/holderInsights";
import type { WalletVelocity } from "@/lib/holderVelocity";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";

import type { ChainView } from "@/lib/chainViews";

/** "combined" or one of the active project's chain keys (src/lib/chainViews.ts). */
export type DisplaySelection = ChainView;

export type SnapshotSource = {
  type?: string | null;
  queryId?: string | null;
  executionId?: string | null;
  executedAt?: string | null;
  refreshedAt?: string | null;
  upstream?: string | null;
  snapshotDate?: string | null;
  chains?: Record<string, { api?: string; fetchedAt?: string }> | null;
};

export type CexFlowTotals = {
  walletCount: number;
  walletCountWithBalance: number;
  previousWalletCountWithBalance: number;
  currentBalance: number;
  previousBalance: number;
  inflow: number;
  outflow: number;
  net: number;
};

export type CexExchangeWallet = {
  address: string;
  walletName?: string;
  currentBalance: number;
  previousBalance?: number;
};

export type CexExchangeTotals = CexFlowTotals & {
  name: string;
  wallets?: CexExchangeWallet[];
};

export type CexFlowSnapshot = {
  generatedAt?: string | null;
  listUpdatedAt?: string | null;
  listQueryId?: string | null;
  overall?: CexFlowTotals | null;
  exchanges?: CexExchangeTotals[];
};

export type HolderCategoryMetrics = {
  count: number;
  balance: number;
};

export type HolderMetrics = {
  holderCount: number;
  totalBalance: number;
  retail: HolderCategoryMetrics;
  underThreshold: HolderCategoryMetrics;
  mega: HolderCategoryMetrics;
  excluded: HolderCategoryMetrics;
  holderCountWithStakers?: number;
};

export type HolderEntry = {
  address: string;
  balance: number;
  stakedBalance: number;
  totalBalance: number;
};

export type ChainSnapshot = {
  key?: string;
  name?: string;
  chainId?: number;
  tokenAddress?: string;
  decimals?: number;
  explorer?: {
    address?: string;
    token?: string;
    holder?: string;
  };
  metrics: HolderMetrics;
  holders: HolderEntry[];
};

export type HolderSnapshotBase = {
  generatedAt: string | null;
  thresholds: {
    retail: number;
    megaHolder: number;
  };
  totals: {
    totalSupply: number;
  };
  chains: Record<string, ChainSnapshot>;
  combined: HolderMetrics;
  chainOrder: string[];
  source: SnapshotSource | null;
  cex?: CexFlowSnapshot | null;
};

export type HolderSnapshot = HolderSnapshotBase & {
  previous?: HolderSnapshotBase | null;
};

export type HolderLiteDistributionRow = {
  label: string;
  count: number;
  totalBalance: number;
  percent: number;
  previousCount: number;
  previousTotalBalance: number;
  previousPercent: number;
};

export type HolderLiteConcentration = {
  top: Record<string, number>;
  previousTop?: Record<string, number> | null;
};

export type HolderLiteView = {
  key: DisplaySelection;
  label: string;
  metrics: HolderMetrics;
  previousMetrics?: HolderMetrics | null;
  concentration: HolderLiteConcentration;
  balanceStats: BalanceStats;
  stakingStats: StakingStats;
  stakingDistribution: StakingDistribution | null;
  distribution: HolderLiteDistributionRow[];
  velocity: WalletVelocity | null;
};

export type HolderLiteSnapshot = {
  generatedAt: string | null;
  thresholds: {
    retail: number;
    megaHolder: number;
  };
  totals: {
    totalSupply: number;
  };
  source: SnapshotSource | null;
  chainOrder: string[];
  /** "combined" plus one view per chain the project is on (keyed by chain key). */
  views: { combined: HolderLiteView } & Record<string, HolderLiteView>;
  overlap: ChainOverlapStats | null;
  cex?: CexFlowSnapshot | null;
};

/** Rejects a payload that parsed as JSON but is not a usable snapshot (an
 *  empty object from a failed pipeline run, a CDN error page served as 200,
 *  ...). Throwing here lets TanStack Query surface the normal error state
 *  instead of the page crashing on `views.combined` further down the tree. */
export const assertHolderLiteSnapshot = (value: unknown): HolderLiteSnapshot => {
  const views = (value as { views?: Record<string, unknown> } | null)?.views;
  if (!views || typeof views !== "object" || !views.combined || typeof views.combined !== "object") {
    throw new Error("Holder snapshot is malformed (missing views.combined)");
  }
  return value as HolderLiteSnapshot;
};

export const fetchHolderLiteSnapshot = async (slug: string): Promise<HolderLiteSnapshot> => {
  const response = await fetch(dataUrl(slug, "holders-lite.json"));

  if (!response.ok) {
    throw new Error(
      `Failed to load holder lite snapshot (${response.status} ${response.statusText})`
    );
  }

  return assertHolderLiteSnapshot(await response.json());
};

const sharedQueryOptions = {
  staleTime: 5 * 60 * 1000,
  gcTime: 24 * 60 * 60 * 1000,
  refetchOnWindowFocus: false,
  refetchOnMount: true,
  refetchOnReconnect: false,
} as const;

export function useHolderLiteSnapshot() {
  const { slug } = useProject();
  return useQuery<HolderLiteSnapshot>({
    queryKey: ["holder-lite", slug],
    queryFn: () => fetchHolderLiteSnapshot(slug),
    ...sharedQueryOptions,
  });
}
