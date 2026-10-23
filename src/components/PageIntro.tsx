import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useHolderLiteSnapshot, type HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { useEcosystemHeadlineTiles } from "@/hooks/useEcosystemHeadlineTiles";
import { buildHolderSummary, type SummaryMetric, type SummaryPoint } from "@/lib/holderSummary";
import { RANGE_OPTIONS } from "@/lib/timeRange";
import { DataFreshnessBadge, StaleDataBanner } from "@/components/DataFreshness";

const TREND_STYLE: Record<SummaryPoint["trend"], { Icon: typeof Minus; cls: string }> = {
  up: { Icon: ArrowUpRight, cls: "text-emerald-700 dark:text-emerald-400" },
  down: { Icon: ArrowDownRight, cls: "text-red-700 dark:text-red-400" },
  flat: { Icon: Minus, cls: "text-muted-foreground" },
  unknown: { Icon: Minus, cls: "text-muted-foreground" },
};

/**
 * First-screen answer to "what is happening with TEL holders?": a real page
 * heading, one plain sentence built from the headline numbers, up to three
 * trend bullets and the data's age. Everything here derives from the same
 * useEcosystemHeadlineTiles values the KPI tiles render, so it cannot drift.
 */
export const PageIntro = ({ rangeDays }: { rangeDays: number }) => {
  const { data, isError } = useHolderLiteSnapshot();
  const snapshot = data as HolderLiteSnapshot | undefined;
  const result = useEcosystemHeadlineTiles(rangeDays);
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

  return (
    <section aria-labelledby="page-title" className="mb-5 sm:mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 id="page-title" className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
          TEL holder distribution
        </h1>
        <DataFreshnessBadge generatedAt={snapshot?.generatedAt} />
      </div>
      {summary ? (
        <div className="max-w-3xl space-y-2" data-testid="page-summary">
          <p className="text-base sm:text-lg leading-snug text-foreground/90">{summary.headline}</p>
          {summary.points.length > 0 && (
            <ul className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-5 text-sm text-muted-foreground">
              {summary.points.map((p) => {
                const { Icon, cls } = TREND_STYLE[p.trend];
                return (
                  <li key={p.id} className="inline-flex items-start gap-1.5">
                    <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${cls}`} />
                    <span>{p.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : isError ? (
        <p className="max-w-3xl text-sm text-muted-foreground">
          Headline numbers are unavailable right now. The panels below explain what failed and let you retry.
        </p>
      ) : (
        <div className="max-w-3xl space-y-2" aria-hidden="true">
          <div className="h-6 w-full max-w-xl rounded-md bg-muted/70 animate-pulse" />
          <div className="h-4 w-2/3 max-w-md rounded-md bg-muted/60 animate-pulse" />
        </div>
      )}
      <StaleDataBanner generatedAt={snapshot?.generatedAt} />
    </section>
  );
};

export default PageIntro;
