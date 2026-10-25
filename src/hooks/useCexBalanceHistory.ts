import { useQuery } from "@tanstack/react-query";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";

export type CexHistoryEntry = {
  date: string;
  exchanges: Record<string, number>;
  total: number;
};

type CexHistoryPayload = {
  generatedAt?: string;
  entries?: CexHistoryEntry[];
};

const resolveUrl = (slug: string) => dataUrl(slug, "cex-balance-history.json");

export const useCexBalanceHistory = () => {
  const { slug } = useProject();
  return useQuery({
    queryKey: ["cex-balance-history", slug],
    queryFn: async (): Promise<CexHistoryEntry[]> => {
      const res = await fetch(resolveUrl(slug));
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      const payload = (await res.json()) as CexHistoryPayload;
      return (payload.entries ?? [])
        .filter((e) => e?.date && e.exchanges)
        .sort((a, b) => a.date.localeCompare(b.date));
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
