import { useQuery } from "@tanstack/react-query";
import { projectChainMeta } from "@/lib/projects";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";

export type ChainStatus = {
  key: string;
  label: string;
  lastBlock: number;
  explorerUrl: string;
  /** Canonical token page (TEL: v3; the pipeline tracks it together with the deprecated legacy contract). */
  tokenUrl: string;
  /** "solana": lastBlock is the snapshot slot. Absent for EVM chains. */
  vm?: "solana";
  /**
   * Solana: this chain's last successful snapshot is older than the feed (a
   * failed run kept the previous entry). EVM entries never set it.
   */
  stale?: boolean;
};

type CheckpointChain = {
  lastBlock?: number;
  vm?: "solana";
  scannedAt?: string;
};

/** A Solana chain is stale when its own scan predates the feed by more than an hour. */
export const isChainStale = (chain: CheckpointChain, generatedAt: string | null | undefined): boolean => {
  if (!chain.scannedAt || !generatedAt) return false;
  const lag = Date.parse(generatedAt) - Date.parse(chain.scannedAt);
  return Number.isFinite(lag) && lag > 60 * 60 * 1000;
};

type Checkpoint = {
  generatedAt?: string;
  chains?: Record<string, CheckpointChain>;
};

const resolveChainStatusUrl = (slug: string) => dataUrl(slug, "chain-status.json");

export const useChainStatus = () => {
  const { slug, project } = useProject();
  // Label / explorer / canonical-token link per chain from the project config,
  // in its declared order (TEL: Ethereum, Polygon, Base — as before).
  const meta = projectChainMeta(project);
  const metaByKey = new Map(meta.map((m) => [m.key, m]));
  const order = meta.map((m) => m.key);
  return useQuery({
    queryKey: ["chain-status", slug],
    queryFn: async (): Promise<{ chains: ChainStatus[]; generatedAt: string | null }> => {
      const url = resolveChainStatusUrl(slug);
      const res = await fetch(url);
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      const data: Checkpoint = await res.json();
      const chains = Object.entries(data.chains ?? {})
        .filter(([key]) => metaByKey.has(key))
        .map(([key, chain]) => {
          const m = metaByKey.get(key)!;
          const base = { key, label: m.label, lastBlock: chain.lastBlock ?? 0, explorerUrl: m.explorerUrl, tokenUrl: m.tokenUrl };
          return chain.vm === "solana"
            ? { ...base, vm: "solana" as const, stale: isChainStale(chain, data.generatedAt) }
            : base;
        })
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      return { chains, generatedAt: data.generatedAt ?? null };
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
