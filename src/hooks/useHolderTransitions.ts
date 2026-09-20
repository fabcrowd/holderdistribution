import { useQuery } from "@tanstack/react-query";

export type TransitionCell = { count: number; tel: number };
export type TransitionMatrix = Record<string, Record<string, TransitionCell>>;
export type TransitionRange = { from: string; to: string; matrix: TransitionMatrix };

export type HolderTransitions = {
  generatedAt?: string;
  latestDate?: string;
  ranges: Record<string, TransitionRange>;
};

const resolveUrl = () => {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}data/holder-transitions.json`;
};

// Map a page rangeDays value to the transitions key (matches the generator).
export const transitionsKeyFor = (rangeDays: number, ytdDays: number): string => {
  if (rangeDays === ytdDays) return "ytd";
  // Must mirror outflowsKeyFor's bucketing exactly (src/hooks/useTierOutflows.ts)
  // — TierFlowDiagram hovers one tier using BOTH this window (for the
  // tier-to-tier arcs) and outflowsKeyFor's window (for the sold/moved/split
  // cause breakdown) at the same time. Missing the <=1 branch here meant a
  // "1D" selection silently showed a 7-day transition matrix next to a
  // 1-day causal breakdown under the same hover.
  if (rangeDays <= 1) return "1";
  if (rangeDays <= 7) return "7";
  if (rangeDays <= 30) return "30";
  if (rangeDays <= 90) return "90";
  return "365";
};

export const useHolderTransitions = () => {
  return useQuery({
    queryKey: ["holder-transitions"],
    queryFn: async (): Promise<HolderTransitions | null> => {
      const res = await fetch(resolveUrl());
      if (!res.ok) return null;
      return (await res.json()) as HolderTransitions;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
