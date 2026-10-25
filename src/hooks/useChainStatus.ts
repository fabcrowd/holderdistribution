import { useQuery } from "@tanstack/react-query";
import { EXPLORER_BASE, v3TokenUrl } from "@/lib/telContracts";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";

export type ChainStatus = {
  key: string;
  label: string;
  lastBlock: number;
  explorerUrl: string;
  /** Canonical TEL v3 token. The pipeline tracks it together with the deprecated legacy contract. */
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
    tokenUrl: v3TokenUrl("ethereum"),
  },
  polygon: {
    label: "Polygon",
    explorerUrl: EXPLORER_BASE.polygon,
    tokenUrl: v3TokenUrl("polygon"),
  },
  base: {
    label: "Base",
    explorerUrl: EXPLORER_BASE.base,
    tokenUrl: v3TokenUrl("base"),
  },
};

const resolveChainStatusUrl = (slug: string) => dataUrl(slug, "chain-status.json");

export const useChainStatus = () => {
  const { slug } = useProject();
  return useQuery({
    queryKey: ["chain-status", slug],
    queryFn: async (): Promise<{ chains: ChainStatus[]; generatedAt: string | null }> => {
      const url = resolveChainStatusUrl(slug);
      const res = await fetch(url);
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
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
