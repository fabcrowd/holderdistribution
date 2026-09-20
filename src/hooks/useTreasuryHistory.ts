import { useQuery } from "@tanstack/react-query";

export type TreasuryHistoryEntry = {
  date: string;
  /** Keyed by the same category strings supply-reconciliation.json uses, so
   *  groupSupplyCategories can group these exactly as it groups the pie. */
  categories: Record<string, number>;
};

export type TreasuryHistory = {
  generatedAt: string;
  source: {
    method: string;
    categories: string[];
    addressCount: number;
    excludes: string;
    anchorDate: string;
  };
  latestByAddress: Record<string, { category: string; balance: number }>;
  entries: TreasuryHistoryEntry[];
};

const resolveUrl = () => {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}data/treasury-history.json`;
};

/**
 * Per-date Association / Telcoin Holdings / escrow balances, reconstructed from
 * Transfer logs (see scripts/backfill-treasury-history.js). Returns null rather
 * than throwing when the artifact is absent, so Supply Breakdown simply omits
 * the chart instead of erroring.
 */
export const useTreasuryHistory = () => {
  return useQuery({
    queryKey: ["treasury-history"],
    queryFn: async (): Promise<TreasuryHistory | null> => {
      const res = await fetch(resolveUrl());
      if (!res.ok) return null;
      return (await res.json()) as TreasuryHistory;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
