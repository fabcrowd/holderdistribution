import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/InfoTooltip";
import type { ClassificationEvent } from "@/lib/classificationChangelog";

const integerFormatter = new Intl.NumberFormat();

export type ChangeIndicatorProps = {
  current: number;
  previous?: number | null;
  className?: string;
  size?: "sm" | "md";
  mode?: "absolute" | "percentage";
  precision?: number;
  formatter?: (value: number) => string;
  /** Force the neutral gray palette regardless of sign — use for metrics
   *  where up/down isn't inherently good/bad (e.g. a change in SHARE of a
   *  pool, where a smaller share can coexist with a larger absolute holding
   *  and coloring it red/green would misleadingly read as a loss/gain). */
  tone?: "auto" | "neutral";
  /** Classification-changelog events (see `useClassificationChangelog`,
   *  `getEventsAffecting`) whose reclassification happened between the
   *  compared dates and affects this metric. When non-empty, the raw diff
   *  is NOT computed or shown — a number that conflates real movement with
   *  a bookkeeping relabel is worse than no number, since a caveat next to
   *  a still-visible figure gets skimmed past. Renders a neutral
   *  "methodology changed" badge with a tooltip explaining what happened
   *  instead. */
  changelogEvents?: ClassificationEvent[];
};

export const ChangeIndicator = ({
  current,
  previous,
  className,
  size = "sm",
  mode = "absolute",
  precision,
  formatter,
  tone = "auto",
  changelogEvents,
}: ChangeIndicatorProps) => {
  if (previous === null || previous === undefined) {
    return null;
  }

  if (changelogEvents && changelogEvents.length > 0) {
    const baseClasses = size === "md" ? "px-2.5 py-0.5 text-sm" : "px-2 py-0.5 text-xs";
    const tooltipText = changelogEvents
      .map((e) => `${e.date}: ${e.summary}`)
      .join("\n\n");
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 font-semibold rounded-full border bg-background/50",
          "border-border/60 text-muted-foreground bg-muted/10",
          baseClasses,
          className,
        )}
      >
        Δ N/A
        <InfoTooltip text={`Classification changed since this comparison's baseline date, so this figure can't be shown as a plain gain/loss:\n\n${tooltipText}`} />
      </span>
    );
  }

  if (mode === "percentage" && previous === 0) {
    return null;
  }

  const diff =
    mode === "percentage"
      ? ((current - previous) / previous) * 100
      : current - previous;
  const baseClasses = size === "md" ? "px-2.5 py-0.5 text-sm" : "px-2 py-0.5 text-xs";

  let palette = "border-border/60 text-muted-foreground bg-muted/10";
  if (tone !== "neutral") {
    if (diff > 0) {
      palette = "border-emerald-500/40 dark:border-emerald-400/40 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30";
    } else if (diff < 0) {
      palette = "border-red-500/40 dark:border-red-400/40 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30";
    }
  }

  const resolvedFormatter = formatter
    ? formatter
    : mode === "percentage"
      ? (value: number) => `${value.toFixed(precision ?? 1)}%`
      : (value: number) => integerFormatter.format(Math.round(value));

  const formattedValue = diff === 0
    ? "0"
    : `${diff > 0 ? "+" : "-"}${resolvedFormatter(Math.abs(diff))}`;

  return (
    <span className={cn(
      "inline-flex items-center font-semibold rounded-full border bg-background/50",
      baseClasses,
      palette,
      className,
    )}
    >
      {formattedValue}
    </span>
  );
};
