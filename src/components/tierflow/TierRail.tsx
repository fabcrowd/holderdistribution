import type { ReactNode } from "react";
import { X } from "lucide-react";
import { AsOfBadge } from "@/components/AsOfBadge";
import { ExplainNumber } from "./ExplainNumber";
import { tierDisplayLabel } from "./geometry";
import { netChangeTip } from "./columnCopy";
import { DEFAULT_FORMATTERS } from "./format";
import { ALL_FLOWS_AVAILABLE, netDisplay, type FlowAvailability } from "./net";
import { textColorForTone, type Tone } from "./palette";
import {
  flowSummaryRows, rankTiersByNet, tierKpis, topCounterparts, verdictTag,
  type FlowSummaryRow, type RailField,
} from "./railSummary";

const SCROLL_MT = "scroll-mt-[calc(var(--header-h,5rem)+0.5rem)]";
const TOP_FLOW_COUNT = 4;
const ICONS: Record<FlowSummaryRow["icon"], string> = { up: "▲", down: "▼", swap: "⇄" };
const ARROW = { up: "▲", down: "▼", flat: "–" } as const;

export type TierRailProps = {
  layout: "terminal" | "stacked";
  metric: "wallets" | "tel";
  ticker: string;
  fields: readonly RailField[];
  selectedField: RailField | null;
  /** Side-tile label when a cause tile (not a tier) is the selection. */
  sideTileLabel: string | null;
  outflowsAsOf: string | null | undefined;
  /** The single aria-live hint. Stacked layout keeps it above the canvas instead. */
  hint?: ReactNode;
  /** Keep the aria-live text for screen readers only (a selection is open). */
  hintHidden?: boolean;
  /** Period totals line shown in the empty state. */
  totalsLine?: ReactNode;
  /** TEL stat cards + gross sentence (terminal layout only). */
  stats?: ReactNode;
  expandedFlow: string | null;
  onSelectTier: (label: string) => void;
  onToggleFlow: (key: string) => void;
  onHoverFlow: (key: string | null) => void;
  onClose: () => void;
  /** Existing WalletsPanel / TelPanel / SideTilePanel. */
  children?: ReactNode;
  /** "View as table" trigger. */
  tableButton?: ReactNode;
  /** Window phrases (columnCopy.periodPhrase) for the "net change" tooltips: wallets use the crossings window, TEL the selected period. */
  period?: { wallets: string; tel: string };
  /** Which feed behind each net exists; a missing one reads "—", not 0. */
  avail?: FlowAvailability;
};

const FlowFigure = ({ row }: { row: FlowSummaryRow }) => (
  <li className="flex min-h-11 items-center justify-between gap-2 text-sm xl:min-h-7" data-flow-summary={row.key}>
    <span className="inline-flex items-center gap-1.5 text-foreground">
      <span aria-hidden="true" className="w-4 text-center text-[13px]" style={{ color: textColorForTone(row.tone) }}>{ICONS[row.icon]}</span>
      {row.label}
    </span>
    <span className="font-semibold tabular-nums" style={{ color: textColorForTone(row.tone) }}>{row.text}</span>
  </li>
);

export const TierRail = ({
  layout, metric, ticker, fields, selectedField, sideTileLabel, outflowsAsOf, hint, hintHidden, totalsLine, stats,
  expandedFlow, onSelectTier, onToggleFlow, onHoverFlow, onClose, children, tableButton, period, avail = ALL_FLOWS_AVAILABLE,
}: TierRailProps) => {
  const fmt = DEFAULT_FORMATTERS;
  const selectedAny = !!(selectedField || sideTileLabel);
  const title = selectedField ? `${tierDisplayLabel(selectedField.label)} tier` : (sideTileLabel ?? "All retail tiers");
  const terminal = layout === "terminal";
  const kpis = selectedField ? tierKpis(selectedField, metric, { ticker, fmt, avail }) : [];
  const flowRows = selectedField ? flowSummaryRows(selectedField, metric, fmt) : [];
  const tag = selectedField && metric === "wallets" ? verdictTag(selectedField.verdict) : null;
  const top = selectedField ? topCounterparts(selectedField, metric, TOP_FLOW_COUNT, fmt) : [];
  const ranked = selectedAny ? [] : rankTiersByNet(fields, metric, avail);
  // -mx-2 + px-2: the hover fill bleeds 8px past the text, so labels and values
  // share the rail title's left edge and the same right edge as the plain rows.
  const rowButton = "-mx-2 w-[calc(100%+1rem)] rounded-md px-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <section
      aria-label={selectedAny ? "Selected tier detail" : "Tier detail"}
      data-testid="panel-tier-detail"
      data-selected={selectedAny}
      className={`${SCROLL_MT} flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 p-3 text-sm ${terminal ? "xl:sticky xl:top-2 xl:max-h-[calc(100vh-1rem)] xl:self-start xl:overflow-auto" : ""}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="text-base font-bold text-foreground">{title}</h3>
        <div className="flex items-center gap-2">
          {terminal && <AsOfBadge iso={outflowsAsOf} label="Flows as of" testId="tier-outflows-asof" />}
          {selectedAny && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close tier detail (Esc)"
              title="Close (Esc)"
              data-testid="tier-detail-close"
              className="inline-flex h-11 w-11 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:h-7 xl:w-7"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {/* Not a live region: each layout announces through exactly one (the terminal's tier-live-summary, the stacked diagram's hint). */}
      {hint && <div className={hintHidden ? "sr-only" : "text-sm leading-snug text-muted-foreground"}>{hint}</div>}

      {selectedField && (
        <>
          <dl className="grid grid-cols-2 gap-2" aria-label="Key figures">
            {kpis.map((k) => (
              <div key={k.key} className="rounded-md border border-border/50 px-2 py-1.5">
                <dt className="flex min-h-6 items-center text-xs text-muted-foreground">
                  {period && (k.key === "netWallets" || k.key === "netTel")
                    ? <ExplainNumber value={k.label} explanation={netChangeTip(k.key === "netWallets" ? period.wallets : period.tel, k.key === "netWallets" ? "wallets" : "tel", ticker)} ariaLabel={`${k.label}: what net means`} className="inline-flex min-h-6 items-center max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-1 max-xl:before:-inset-y-3 max-xl:before:content-['']" />
                    : k.label}
                </dt>
                <dd className="text-base font-bold tabular-nums" style={{ color: textColorForTone(k.tone as Tone) }}>{k.text}</dd>
              </div>
            ))}
          </dl>

          <div>
            <h4 className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {metric === "wallets" ? "Wallet moves" : "Flows"}
            </h4>
            <ul>{flowRows.map((r) => <FlowFigure key={r.key} row={r} />)}</ul>
            {tag && (
              <span className="mt-1 inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground" data-testid="verdict-tag">
                {tag}
              </span>
            )}
          </div>

          {top.length > 0 && (
            <div>
              <h4 className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Top gross flows</h4>
              <ul>
                {top.map((c) => (
                  <li key={c.key}>
                    <button
                      type="button"
                      onClick={() => onToggleFlow(c.key)}
                      onMouseEnter={() => onHoverFlow(c.key)}
                      onMouseLeave={() => onHoverFlow(null)}
                      onFocus={() => onHoverFlow(c.key)}
                      onBlur={() => onHoverFlow(null)}
                      aria-expanded={expandedFlow === c.key}
                      data-top-flow={c.key}
                      className={`${rowButton} ${SCROLL_MT} flex min-h-11 items-center justify-between gap-2 xl:min-h-7`}
                    >
                      <span className="text-foreground">{metric === "wallets" ? tierDisplayLabel(c.label) : c.label}</span>
                      <span className="tabular-nums text-muted-foreground">{c.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {!selectedAny && (
        <>
          {totalsLine}
          {ranked.length > 0 && (
            <div>
              <h4 className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {period ? (
                  <ExplainNumber value="Tiers by net change" explanation={netChangeTip(period[metric], metric, ticker)} ariaLabel="Tiers by net change: what net means" className="inline-flex min-h-6 items-center max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-1 max-xl:before:-inset-y-3 max-xl:before:content-['']" />
                ) : "Tiers by net change"}
              </h4>
              <ul data-testid="tier-rank-list">
                {ranked.map((r) => {
                  const tone: Tone = r.direction === "up" ? "positive" : r.direction === "down" ? "negative" : "neutral";
                  const f = metric === "wallets" ? fmt.fmtInt : fmt.fmtTel;
                  return (
                    <li key={r.label}>
                      <button
                        type="button"
                        onClick={() => onSelectTier(r.label)}
                        data-rank-tier={r.label}
                        className={`${rowButton} ${SCROLL_MT} flex min-h-11 items-center justify-between gap-2 xl:min-h-7`}
                      >
                        <span className="text-foreground">{tierDisplayLabel(r.label)}</span>
                        <span className="inline-flex items-center gap-1 font-semibold tabular-nums" style={{ color: textColorForTone(tone) }}>
                          <span aria-hidden="true" className="text-[13px]">{ARROW[r.direction]}</span>
                          {netDisplay(r.net, f).text}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {stats}
        </>
      )}

      {selectedAny && stats}
      {children && <div className="terminal-detail">{children}</div>}
      {tableButton}
    </section>
  );
};
