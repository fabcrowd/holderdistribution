import { useHolderLiteSnapshot, type HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { useEcosystemHeadlineTiles, type HeadlineView } from "@/hooks/useEcosystemHeadlineTiles";
import { buildHolderSummary, type SummaryMetric } from "@/lib/holderSummary";
import { RANGE_OPTIONS } from "@/lib/timeRange";

/** The plain-language headline + trend bullets, from the same tile values the KPIs show. */
export const useHeadlineSummary = (rangeDays: number, chain: HeadlineView = "combined") => {
  const { data, isError } = useHolderLiteSnapshot();
  const snapshot = data as HolderLiteSnapshot | undefined;
  const result = useEcosystemHeadlineTiles(rangeDays, chain);
  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`;
  const metric = (id: string): SummaryMetric => {
    const t = result?.tiles.find((x) => x.id === id);
    return {
      current: t?.current ?? null,
      previous: t?.previous ?? null,
      comparisonBlocked: (t?.changelogEvents?.length ?? 0) > 0,
    };
  };
  const summary =
    snapshot && result
      ? buildHolderSummary({
          holders: metric("holders"),
          retailHeld: metric("retailHeld"),
          staked: metric("staked"),
          cex: metric("cex"),
          totalSupply: snapshot.totals.totalSupply,
          rangeLabel,
        })
      : null;
  return { summary, snapshot, isError, tiles: result?.tiles ?? [] };
};
