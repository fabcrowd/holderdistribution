import { useQuery } from "@tanstack/react-query";

export type ChainStatus = {
  key: string;
  label: string;
  lastBlock: number;
  explorerUrl: string;
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
    explorerUrl: "https://etherscan.io",
    tokenUrl: "https://etherscan.io/token/0x467bccd9d29f223bce8043b84e8c8b282827790f",
  },
  polygon: {
    label: "Polygon",
    explorerUrl: "https://polygonscan.com",
    tokenUrl: "https://polygonscan.com/token/0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
  },
  base: {
    label: "Base",
    explorerUrl: "https://basescan.org",
    tokenUrl: "https://basescan.org/token/0x09be1692ca16e06f536f0038ff11d1da8524adb1",
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
