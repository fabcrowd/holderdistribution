import { useQuery } from "@tanstack/react-query";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";
import { withFeedAsOf, type FeedAsOf, type WithAsOf } from "@/hooks/useFeedAsOf";

export type CexHistoryEntry = {
  date: string;
  exchanges: Record<string, number>;
  total: number;
};

type CexHistoryPayload = {
  generatedAt?: string;
  asOf?: FeedAsOf;
  entries?: CexHistoryEntry[];
};

const resolveUrl = (slug: string) => dataUrl(slug, "cex-balance-history.json");

/** Per-exchange balance history; the array also carries the feed's `asOf` (read with feedAsOf). */
export const useCexBalanceHistory = () => {
  const { slug } = useProject();
  return useQuery({
    queryKey: ["cex-balance-history", slug],
    queryFn: async (): Promise<WithAsOf<CexHistoryEntry>> => {
      const res = await fetch(resolveUrl(slug));
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      const payload = (await res.json()) as CexHistoryPayload;
      const rows = (payload.entries ?? [])
        .filter((e) => e?.date && e.exchanges)
        .sort((a, b) => a.date.localeCompare(b.date));
      return withFeedAsOf(rows, payload);
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    structuralSharing: false,
  });
};
