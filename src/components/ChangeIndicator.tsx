import { cn } from "@/lib/utils";
import { isZeroText } from "@/lib/format";
import { InfoTooltip } from "@/components/InfoTooltip";
import { InfoTip } from "@/components/InfoTip";
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
  /** "pill" (default) is the bordered chip used in cards. "plain" is the
   *  dense header form: a coloured signed number, and a "†" marker (with the
   *  same explainer) in place of the "Relabeled" chip. */
  variant?: "pill" | "plain";
};

const relabelText = (events: ClassificationEvent[]) =>
  `Some wallets were reclassified since this comparison's start date (e.g. later identified as an exchange), so the change can't be shown as a plain gain or loss:\n\n${events
    .map((e) => `${e.date}: ${e.summary}`)
    .join("\n\n")}`;

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
  variant = "pill",
}: ChangeIndicatorProps) => {
  if (previous === null || previous === undefined) {
    return null;
  }

  if (variant === "plain" && changelogEvents && changelogEvents.length > 0) {
    return (
      <InfoTip
        content={relabelText(changelogEvents)}
        label="Change not shown: some wallets were reclassified. Details"
        className={cn("-my-1 -ml-1 text-sm font-semibold text-muted-foreground", className)}
      >
        <span aria-hidden="true">†</span>
      </InfoTip>
    );
  }

  if (changelogEvents && changelogEvents.length > 0) {
    const baseClasses = size === "md" ? "px-2.5 py-0.5 text-sm" : "px-2 py-0.5 text-xs";
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 font-semibold rounded-full border bg-background/50",
          "border-border/60 text-muted-foreground bg-muted/10",
          baseClasses,
          className,
        )}
      >
        Relabeled
        <InfoTooltip text={relabelText(changelogEvents)} />
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
      palette = "border-emerald-500/40 dark:border-emerald-400/40 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30";
    } else if (diff < 0) {
      palette = "border-red-500/40 dark:border-red-400/40 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30";
    }
  }

  const resolvedFormatter = formatter
    ? formatter
    : mode === "percentage"
      ? (value: number) => `${value.toFixed(precision ?? 1)}%`
      : (value: number) => integerFormatter.format(Math.round(value));

  const magnitude = resolvedFormatter(Math.abs(diff));
  // Rounds to zero → "0" (never "−0"), and no up/down colouring.
  const formattedValue = diff === 0 || isZeroText(magnitude)
    ? diff === 0 ? "0" : magnitude
    : `${diff > 0 ? "+" : "-"}${magnitude}`;
  const flat = diff === 0 || isZeroText(magnitude);
  if (flat) palette = "border-border/60 text-muted-foreground bg-muted/10";

  if (variant === "plain") {
    const plainTone =
      tone === "neutral" || flat ? "text-muted-foreground" : diff > 0 ? "text-positive" : "text-negative";
    return (
      <span className={cn("text-xs font-semibold tabular-nums", plainTone, className)}>
        {formattedValue.replace(/^-/, "−")}
      </span>
    );
  }

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
