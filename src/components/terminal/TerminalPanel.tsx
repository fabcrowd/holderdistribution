import { type ReactNode, useId } from "react";
import { RotateCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { InfoTip } from "@/components/InfoTip";
import { isZeroText } from "@/lib/format";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import type { ClassificationEvent } from "@/lib/classificationChangelog";
import { CHART_HEIGHT_CLASS, type ChartTier } from "@/lib/terminalLayout";

type TerminalPanelProps = {
  title: ReactNode;
  /** Plain-text title for labels when `title` is not a string. */
  titleText?: string;
  /** Explainer shown in the (i) tip rather than taking a row. Strings keep line breaks; a node can include proof links. */
  info?: ReactNode;
  /** Headline figure(s) beside the title, e.g. the current value + change. */
  stat?: ReactNode;
  /** Right-aligned header controls (toggles, "Details" link). */
  actions?: ReactNode;
  className?: string;
  /** Body padding off for edge-to-edge tables. */
  flush?: boolean;
  /**
   * Size to the body instead of filling a fixed grid cell. Used when the
   * terminal page itself scrolls (tier flows at 1:1) so the panel grows
   * with the diagram rather than squeezing it.
   */
  fit?: boolean;
  /**
   * Chart panel: the body gets a fixed height TIER (see terminalLayout) so
   * the chart has a definite height whatever else is in the row. Without it
   * or `fit` the body fills a grid cell the parent sized (legacy views).
   */
  chart?: ChartTier;
  children: ReactNode;
  testId?: string;
};

/**
 * Dashboard cell. Chart panels pass `chart` (a height tier) and tables pass
 * `fit`, so every panel is sized by its content and the page scrolls, not the
 * panel. Without either, the body fills a cell the parent sized and scrolls.
 */
export const TerminalPanel = ({ title, titleText, info, stat, actions, className = "", flush = false, fit = false, chart, children, testId }: TerminalPanelProps) => {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={`relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card ${fit || chart ? "" : "min-h-0"} ${className}`}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <h2 id={headingId} className="shrink-0 whitespace-nowrap text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {info && <InfoTip content={info} label={`About ${titleText ?? (typeof title === "string" ? title : "this panel")}`} className="-m-1" />}
        {stat && <div className="ml-1 flex min-w-0 items-baseline gap-2 truncate text-lg tabular-nums">{stat}</div>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      {/* Table panels scroll internally, so their body takes focus (keyboard
          scrolling; axe scrollable-region-focusable). role="group", not
          "region": the <section> around it is already the named landmark,
          and a second landmark with the same name fails landmark-unique. */}
      <div
        className={
          chart
            ? `relative shrink-0 overflow-hidden p-3 ${CHART_HEIGHT_CLASS[chart]}`
            : fit
              ? flush
                ? ""
                : "p-3"
              : `relative min-h-0 flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${flush ? "" : "p-3"}`
        }
        tabIndex={!fit && !chart && flush ? 0 : undefined}
        aria-labelledby={!fit && !chart && flush ? headingId : undefined}
        role={!fit && !chart && flush ? "group" : undefined}
      >
        {children}
      </div>
    </section>
  );
};

export const PanelMessage = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">{children}</div>
);

/**
 * A feed failed (network error, or a body that is not valid JSON — e.g. an
 * HTML fallback page). Says so and offers a retry instead of spinning
 * forever. Retry refetches every query currently in the error state.
 */
export const PanelError = ({ children = "This feed couldn't be loaded." }: { children?: ReactNode }) => {
  const qc = useQueryClient();
  return (
    // No role="alert": several panels can fail together, and the footer
    // already announces the outage once.
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground" data-testid="panel-error">
      <span>{children}</span>
      <button
        type="button"
        onClick={() => void qc.refetchQueries({ predicate: (q) => q.state.status === "error" })}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RotateCw className="h-3 w-3" aria-hidden="true" />
        Retry
      </button>
    </div>
  );
};

export const PanelSkeleton = () => (
  <div role="status" aria-label="Loading" className="h-full w-full animate-pulse rounded-md bg-muted/60">
    <span className="sr-only">Loading…</span>
  </div>
);

/** Signed change chip: green up, red down, muted when flat/unknown. */
export const Delta = ({
  value,
  format,
  suffix = "",
  relabel,
}: {
  value: number | null | undefined;
  format: (n: number) => string;
  suffix?: string;
  /** Reclassifications after this delta's baseline for the metric it shows.
   *  Same rule as the header KPIs: the number is replaced by a "†" that
   *  explains why, since part of the change is relabelling, not movement. */
  relabel?: ClassificationEvent[];
}) => {
  if (relabel && relabel.length > 0 && value != null) {
    return <ChangeIndicator variant="plain" current={0} previous={0} changelogEvents={relabel} className="text-xs" />;
  }
  if (value == null || !Number.isFinite(value)) return <span className="text-xs text-muted-foreground">—</span>;
  const mag = format(Math.abs(value));
  // A change that rounds to zero reads "0", never "−0" / "+0".
  const v = isZeroText(mag) ? 0 : value;
  const tone = v > 0 ? "text-positive" : v < 0 ? "text-negative" : "text-muted-foreground";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return (
    <span className={`text-xs font-semibold tabular-nums ${tone}`}>
      {sign}
      {mag}
      {suffix}
    </span>
  );
};
