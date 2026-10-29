import { useQuery } from "@tanstack/react-query";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";

export type SupplyReconciliationItem = {
  address: string;
  category: string;
  name: string | null;
  balance: number;
  counted: boolean;
  /** TEL at this address contractually committed elsewhere (e.g. a SAFE's
   * return-to-treasury clause), excluded from `circulating` regardless of
   * `category`. Present only when the address has an override. */
  nonCirculatingOverride?: number;
};

export type SupplyResidualParts = {
  /** L1 bridge lock minus L2 mirrored balances (usually positive = in-flight). */
  bridgeInFlight: number;
  /** Origin-chain legacy TEL in the holder scan minus the 100B total supply. */
  originDrift: number;
  /** Legacy TEL retired into v3 minus v3 supply (≈ 0; v3 bridge in-flight). Absent before the v3 upgrade. */
  upgradeUnbacked?: number;
};

/** TEL v3 upgrade ledger. Absent on snapshots that predate v3 tracking. */
export type SupplyUpgrade = {
  /** Legacy TEL locked in the upgrade contracts in exchange for minted v3 (left out of every bucket). */
  retiredLegacy: number;
  retiredLegacyByChain: Record<string, number>;
  /** TEL v3 totalSupply summed over chains (counted in the holder buckets). */
  v3Supply: number;
  v3SupplyByChain: Record<string, number>;
  legacySupplyByChain: Record<string, number>;
  /** Legacy sent to an upgrade contract with no swap — counted once, on the contract. */
  strandedInUpgrade: number;
  strandedInUpgradeByChain: Record<string, number>;
};

export type SupplyCirculatingExclusions = {
  /** Sum of every nonCirculatingOverride actually applied (clamped to balance). */
  total: number;
  items: Array<{ address: string; name: string | null; amount: number }>;
};

export type SupplyReconciliation = {
  totalSupply: number;
  derivedOriginTotal: number;
  bridgeLocked: number;
  mirrored: number;
  mirrorResidual: number;
  residual: number;
  residualParts: SupplyResidualParts;
  upgrade?: SupplyUpgrade;
  categories: Record<string, number>;
  counted: number;
  circulating: number;
  circulatingExclusions: SupplyCirculatingExclusions;
  /** Non-empty when a nonCirculatingOverride has drifted stale against the
   * address's real balance — see scripts/lib/reconcileSupply.js. */
  warnings: string[];
  /** This project's CoinGecko circulating supply, for comparison only.
   * Null hides the row — never filled from another project's figure. */
  coingeckoCirculating: number | null;
  items: SupplyReconciliationItem[];
};

const resolveUrl = (slug: string) => dataUrl(slug, "supply-reconciliation.json");

export const useSupplyReconciliation = () => {
  const { slug } = useProject();
  return useQuery({
    queryKey: ["supply-reconciliation", slug],
    queryFn: async (): Promise<SupplyReconciliation | null> => {
      const res = await fetch(resolveUrl(slug));
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      return (await res.json()) as SupplyReconciliation;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
