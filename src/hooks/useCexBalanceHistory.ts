import { useQuery } from "@tanstack/react-query";
import { resolveDataUrl } from "@/lib/dataUrl";
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

const resolveUrl = () => {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return resolveDataUrl("cex-balance-history.json", { base: normalized });
};

export const useCexBalanceHistory = () => {
  return useQuery({
    queryKey: ["cex-balance-history"],
    queryFn: async (): Promise<CexHistoryEntry[]> => {
      const res = await fetch(resolveUrl());
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
