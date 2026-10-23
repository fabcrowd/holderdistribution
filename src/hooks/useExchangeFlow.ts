import { useQuery } from "@tanstack/react-query";
import { resolveDataUrl } from "@/lib/dataUrl";
import { FeedError } from "@/lib/fetchJson";

export type ExchangeFlowEntry = {
  date: string;
  chains?: Record<string, { in: number; out: number; dexIn?: number; dexOut?: number }>;
  in: number;
  out: number;
  net: number;
  // DEX swap flows (schema v2+): dexIn = TEL sold into pools, dexOut = TEL
  // bought out of pools. Absent on pre-v2 entries.
  dexIn?: number;
  dexOut?: number;
  dexNet?: number;
};

type ExchangeFlowPayload = {
  generatedAt?: string;
  entries?: ExchangeFlowEntry[];
};

const resolveUrl = () => {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return resolveDataUrl("exchange-flow-history.json", { base: normalized });
};

/**
 * Daily exchange inflow / outflow / net, measured directly from TEL Transfer
 * logs (deposits to and withdrawals from known exchange wallets). Neutral
 * "netflow" series — a deposit is not a sale, only supply moving toward the
 * market; a withdrawal is supply leaving it.
 */
export const useExchangeFlow = () => {
  return useQuery({
    queryKey: ["exchange-flow-history"],
    queryFn: async (): Promise<ExchangeFlowEntry[]> => {
      const res = await fetch(resolveUrl());
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      const payload = (await res.json()) as ExchangeFlowPayload;
      return (payload.entries ?? [])
        .filter((e) => e?.date)
        .sort((a, b) => a.date.localeCompare(b.date));
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
