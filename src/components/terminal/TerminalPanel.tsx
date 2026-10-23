import { type ReactNode, useId } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type TerminalPanelProps = {
  title: string;
  /** One-line explainer, shown in a tooltip rather than taking a row. */
  info?: string;
  /** Headline figure(s) beside the title, e.g. the current value + change. */
  stat?: ReactNode;
  /** Right-aligned header controls (toggles, "Details" link). */
  actions?: ReactNode;
  className?: string;
  /** Body padding off for edge-to-edge tables. */
  flush?: boolean;
  children: ReactNode;
  testId?: string;
};

/**
 * Fixed-height dashboard cell. The grid decides the size; the header is one
 * 32px line; the body takes the rest and scrolls INSIDE the panel, so a long
 * table never grows the page.
 */
export const TerminalPanel = ({ title, info, stat, actions, className = "", flush = false, children, testId }: TerminalPanelProps) => {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card ${className}`}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <h2 id={headingId} className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {info && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`About ${title}`}
                className="-m-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
              {info}
            </TooltipContent>
          </Tooltip>
        )}
        {stat && <div className="ml-1 flex min-w-0 items-baseline gap-2 truncate text-sm tabular-nums">{stat}</div>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      {/* Table panels scroll internally, so their body takes focus (keyboard
          scrolling; axe scrollable-region-focusable). */}
      <div
        className={`relative min-h-0 flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${flush ? "" : "p-2"}`}
        tabIndex={flush ? 0 : undefined}
        aria-labelledby={flush ? headingId : undefined}
        role={flush ? "region" : undefined}
      >
        {children}
      </div>
    </section>
  );
};

export const PanelMessage = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">{children}</div>
);

export const PanelSkeleton = () => (
  <div role="status" aria-label="Loading" className="h-full w-full animate-pulse rounded-md bg-muted/60">
    <span className="sr-only">Loading…</span>
  </div>
);

/** Signed change chip: green up, red down, muted when flat/unknown. */
export const Delta = ({ value, format, suffix = "" }: { value: number | null | undefined; format: (n: number) => string; suffix?: string }) => {
  if (value == null || !Number.isFinite(value)) return <span className="text-xs text-muted-foreground">—</span>;
  const tone = value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-muted-foreground";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return (
    <span className={`text-xs font-semibold tabular-nums ${tone}`}>
      {sign}
      {format(Math.abs(value))}
      {suffix}
    </span>
  );
};
