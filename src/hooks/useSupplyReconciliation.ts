import { useQuery } from "@tanstack/react-query";

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
  /** CoinGecko's reported circulating supply, for comparison only — see
   * scripts/lib/reconcileSupply.js for why it's a frozen 2025-10-01 snapshot. */
  coingeckoCirculating: number;
  items: SupplyReconciliationItem[];
};

const resolveUrl = () => {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}data/supply-reconciliation.json`;
};

export const useSupplyReconciliation = () => {
  return useQuery({
    queryKey: ["supply-reconciliation"],
    queryFn: async (): Promise<SupplyReconciliation | null> => {
      const res = await fetch(resolveUrl());
      if (!res.ok) return null;
      return (await res.json()) as SupplyReconciliation;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
