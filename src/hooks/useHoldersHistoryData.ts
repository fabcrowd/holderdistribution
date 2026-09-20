import { useQuery } from "@tanstack/react-query";

export type HolderHistoryChainEntry = {
  holderCount: number;
  retailHolderCount: number;
  totalBalance?: number;
  concentration?: Record<string, number>;
  distribution?: Array<{ label: string; count: number; totalBalance: number }>;
};

export type HolderHistoryEntry = {
  date: string;
  generatedAt: string;
  combined: {
    holderCount: number;
    retailHolderCount: number;
    totalBalance: number;
    totalHeld?: number;
    stakingBalance?: number;
    /** TEL sitting in known DEX pools/routers (retail-owned LP). */
    dexLiquidity?: number;
    /** CEX custody balance, sourced from cex-balance-history.json. */
    cexBalance?: number;
    holderCountWithStakers?: number;
  };
  concentration?: Record<string, number>;
  distribution?: Array<{ label: string; count: number; totalBalance: number }>;
  cumulativeHolders?: number;
  chains: Record<string, HolderHistoryChainEntry>;
};

export type HolderHistoryPayload = {
  generatedAt?: string;
  entries?: HolderHistoryEntry[];
};

const withTrailingSlash = (value: string) => (value.endsWith("/") ? value : `${value}/`);

const ensureLeadingSlash = (value: string) => {
  if (!value) {
    return "/";
  }

  const hasProtocol = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value);
  if (hasProtocol) {
    return value;
  }

  return value.startsWith("/") ? value : `/${value}`;
};

export const resolveHolderHistoryUrl = () => {
  const explicit = import.meta.env.VITE_HOLDER_HISTORY_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const base = import.meta.env.BASE_URL ?? "/";
  const normalizedBase = withTrailingSlash(ensureLeadingSlash(base));
  return `${normalizedBase}data/holders-history.json`;
};

/**
 * Fetches the raw holders-history.json payload exactly once and shares it
 * across every consumer via a single stable query key. view/days-specific
 * derivation happens in the consuming hooks via useMemo, not here — this
 * hook only owns the network fetch and caching of the raw resource.
 */
export const useHoldersHistoryData = () => {
  return useQuery<HolderHistoryPayload>({
    queryKey: ["holders-history"],
    queryFn: async () => {
      const url = resolveHolderHistoryUrl();
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) {
          return {} as HolderHistoryPayload;
        }
        const errorBody = await response.json().catch(() => ({}));
        const message =
          typeof errorBody?.error === "string" ? errorBody.error : `Request failed (${response.status})`;
        throw new Error(message);
      }
      return (await response.json()) as HolderHistoryPayload;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    refetchOnReconnect: false,
  });
};
