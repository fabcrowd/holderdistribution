import { useQuery } from "@tanstack/react-query";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";

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

const resolveUrl = (slug: string) => dataUrl(slug, "treasury-history.json");

/**
 * Per-date Association / Telcoin Holdings / escrow balances, reconstructed from
 * Transfer logs (see scripts/backfill-treasury-history.js). Returns null rather
 * than throwing when the artifact is absent, so Supply Breakdown simply omits
 * the chart instead of erroring.
 */
export const useTreasuryHistory = () => {
  const { slug } = useProject();
  return useQuery({
    queryKey: ["treasury-history", slug],
    queryFn: async (): Promise<TreasuryHistory | null> => {
      const res = await fetch(resolveUrl(slug));
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      return (await res.json()) as TreasuryHistory;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
