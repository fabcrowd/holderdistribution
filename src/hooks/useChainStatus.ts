import { useQuery } from "@tanstack/react-query";
import { EXPLORER_BASE, legacyTokenUrl } from "@/lib/telContracts";

export type ChainStatus = {
  key: string;
  label: string;
  lastBlock: number;
  explorerUrl: string;
  /** Legacy (2-decimal) TEL contract — the one the holder pipeline tracks. */
  tokenUrl: string;
};

type CheckpointChain = {
  lastBlock?: number;
};

type Checkpoint = {
  generatedAt?: string;
  chains?: Record<string, CheckpointChain>;
};

const CHAIN_META: Record<string, { label: string; explorerUrl: string; tokenUrl: string }> = {
  ethereum: {
    label: "Ethereum",
    explorerUrl: EXPLORER_BASE.ethereum,
    tokenUrl: legacyTokenUrl("ethereum"),
  },
  polygon: {
    label: "Polygon",
    explorerUrl: EXPLORER_BASE.polygon,
    tokenUrl: legacyTokenUrl("polygon"),
  },
  base: {
    label: "Base",
    explorerUrl: EXPLORER_BASE.base,
    tokenUrl: legacyTokenUrl("base"),
  },
};

const resolveCheckpointUrl = () => {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}data/holders-checkpoint.json`;
};

export const useChainStatus = () => {
  return useQuery({
    queryKey: ["chain-status"],
    queryFn: async (): Promise<{ chains: ChainStatus[]; generatedAt: string | null }> => {
      const url = resolveCheckpointUrl();
      const res = await fetch(url);
      if (!res.ok) return { chains: [], generatedAt: null };
      const data: Checkpoint = await res.json();
      const chains = Object.entries(data.chains ?? {})
        .filter(([key]) => CHAIN_META[key])
        .map(([key, chain]) => ({
          key,
          label: CHAIN_META[key].label,
          lastBlock: chain.lastBlock ?? 0,
          explorerUrl: CHAIN_META[key].explorerUrl,
          tokenUrl: CHAIN_META[key].tokenUrl,
        }))
        .sort((a, b) => {
          const order = ["ethereum", "polygon", "base"];
          return order.indexOf(a.key) - order.indexOf(b.key);
        });
      return { chains, generatedAt: data.generatedAt ?? null };
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
