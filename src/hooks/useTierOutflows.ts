import { useQuery } from "@tanstack/react-query";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";

export type TierOutflowCell = {
  dex: number;
  /** Swap-only portion of `dex` (schema additive). Absent on pre-classification days. */
  dexSwap?: number;
  /** LP add/remove portion of `dex` (schema additive). */
  dexLp?: number;
  cex: number;
  moved: number;
  // Fan-out (schema v5+): wallets that split their position across >=2 wallets
  // in a day, and the TEL they distributed. splitWallets is the number of
  // distinct destination wallets summed across all such fan-out events in
  // this window (schema v8+ — before that it was miscounting events, not
  // wallets); splitEvents (v8+) is the number of separate (day, sender)
  // fan-out occurrences. Absent on pre-v5 data.
  splitWallets?: number;
  // The honest name for the same figure as splitWallets: destination *slots*
  // summed across the window, NOT distinct wallets (the same wallet recurring
  // on multiple days counts once per day). Prefer this field — splitWallets
  // is kept only so the pre-v10 UI doesn't regress mid-rollout.
  splitDestinationSlots?: number;
  splitEvents?: number;
  splitTel?: number;
  /** Exchange deposits attributed by receiving exchange (schema v6+). */
  byExchange?: Record<string, number>;
  /** Why this tier GREW (schema v7+): TEL received, classified by sender —
   *  bought on a DEX, withdrawn from a CEX, or received from another wallet. */
  inflows?: { dex: number; dexSwap?: number; dexLp?: number; cex: number; wallet: number };
  /** Sparse per-chain breakdown (v10+) — a chain key is present only once it
   *  has a non-zero contribution. Absent chains should read as "not measured
   *  this window", not zero. */
  byChain?: Record<string, {
    dex: number; dexSwap?: number; dexLp?: number; cex: number; moved: number;
    inflows: { dex: number; dexSwap?: number; dexLp?: number; cex: number; wallet: number };
  }>;
  /** Counterparty-tier attribution for `inflows.wallet` (schema v11+) — sparse,
   *  sums exactly to `inflows.wallet`. Key is a tier label or "untracked"
   *  (counterparty had no tier, or the day predates this feature). */
  inflowsBySourceTier?: Record<string, number>;
  /** Counterparty-tier attribution for `moved` (schema v11+) — sparse, sums
   *  exactly to `moved`. Key is a tier label or "untracked". */
  movedByDestTier?: Record<string, number>;
};
export type TierOutflowRange = {
  from: string;
  to: string;
  tiers: Record<string, TierOutflowCell>;
  /** Days in this window with real counterparty-tier attribution (schema v11+). */
  attributedDays?: number;
  /** Total days in this window. */
  totalDays?: number;
};

export type TierOutflows = {
  schema?: number;
  generatedAt?: string;
  complete?: boolean;
  latestDate?: string;
  /** Earliest day with real counterparty-tier attribution, or null if none yet (schema v11+). */
  sourceTierSince?: string | null;
  ranges: Record<string, TierOutflowRange>;
};

const resolveUrl = (slug: string) => dataUrl(slug, "tier-outflows.json");

// Map a page rangeDays to the generator's window key. Covers the full
// timeframe selector: 1/7/30/90/365 rolling windows plus calendar YTD.
export const outflowsKeyFor = (rangeDays: number, ytd: number): string => {
  if (rangeDays === ytd) return "ytd";
  if (rangeDays <= 1) return "1";
  if (rangeDays <= 7) return "7";
  if (rangeDays <= 30) return "30";
  if (rangeDays <= 90) return "90";
  return "365";
};

export const useTierOutflows = () => {
  const { slug } = useProject();
  return useQuery({
    queryKey: ["tier-outflows", slug],
    queryFn: async (): Promise<TierOutflows | null> => {
      // No Date.now() cache-buster: this data refreshes once a day, so a
      // stable URL lets Netlify's edge cache actually serve it (see
      // netlify.toml's Cache-Control for /data/*) instead of guaranteeing a
      // full-size origin fetch on every single page view. `no-store` still
      // stops the BROWSER's own disk cache from serving something stale
      // across visits — the edge cache is what's meant to absorb repeat load.
      const res = await fetch(resolveUrl(slug), { cache: "no-store" });
      // Not published yet (Solana projects have no EVM transfer scan). An empty
      // document settles the query so the panel can show an empty state, or
      // the wallet diagram from holder-transitions, instead of retrying the
      // 404 and sitting on the loading skeleton.
      if (res.status === 404) return { ranges: {}, complete: false };
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      return (await res.json()) as TierOutflows;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
