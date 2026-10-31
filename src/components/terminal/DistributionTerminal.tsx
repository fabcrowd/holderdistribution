import { useProject } from "@/hooks/useProject";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChartIntro, useIntro } from "@/hooks/useMotion";
import { CHART_DRAW_MS } from "@/lib/motion";
import { signedInt } from "@/lib/format";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DisplaySelection, HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { useHolderHistoricalDelta } from "@/hooks/useHolderHistoricalDelta";
import { useClassificationChangelog, getEventsAffecting } from "@/hooks/useClassificationChangelog";
import { TierFlowDiagram, type TierMetric } from "@/components/TierFlowDiagram";
import { tierDisplayLabel } from "@/components/tierflow/geometry";
import { SIDE_TILE_LABELS } from "@/components/tierflow/netFlow";
import { useFlowField, type ChainKey } from "@/components/tierflow/useFlowField";
import { ALL_CHAIN_CROSSINGS_NOTE, netByTierRows } from "@/components/tierflow/netByTier";
import { tierTileSelector } from "@/components/tierflow/focusTier";
import { mergeDistributionBaseline } from "@/lib/distributionRows";
import {
  EMPTY_SELECTION, defaultTierLabel, hasSelection, reduceSelection, shouldClearOnEscape, type DistAction, type DistSelection,
} from "@/lib/distributionSelection";
import { TIER_FLOWS_EXPLAINER } from "@/lib/terminalCopy";
import { CHART_TICK, TYPE_PX } from "@/lib/terminalLayout";
import { useTierGeometry } from "@/components/tierflow/useTierGeometry";
import { RANGE_OPTIONS } from "@/lib/timeRange";
import { formatCompact } from "@/lib/format";
import { barSizing, computeYAxisFromRows, distinctTickFormatter } from "@/lib/chartAxes";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { TerminalPanel, PanelMessage, PanelError, PanelSkeleton, Delta } from "./TerminalPanel";

/** Room beyond the longest bar for its value label. */
const NET_LABEL_HEADROOM = 0.3;

const int = new Intl.NumberFormat("en-US");


type BarLabelProps = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: number | string };

/** Value at the outer end of each net-change bar (right of positives, left of negatives). */
const NetBarLabel = (props: BarLabelProps) => {
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const w = Number(props.width ?? 0);
  const h = Number(props.height ?? 0);
  const v = Number(props.value ?? 0);
  if (!Number.isFinite(v)) return null;
  const left = Math.min(x, x + w);
  const right = Math.max(x, x + w);
  const neg = v < 0;
  return (
    <text
      x={neg ? left - 3 : right + 3}
      y={y + h / 2}
      dy="0.35em"
      textAnchor={neg ? "end" : "start"}
      fontSize={TYPE_PX.caption}
      className="tabular-nums"
      fill="hsl(var(--foreground))"
      aria-hidden="true"
    >
      {signedInt(v)}
    </text>
  );
};

type Props = {
  snapshot: HolderLiteSnapshot | undefined;
  snapshotError: boolean;
  selectedView: DisplaySelection;
  rangeDays: number;
};

const chainKeyFor = (v: DisplaySelection): ChainKey => (v === "combined" ? "all" : v);

/**
 * Desktop Distribution view. The tier diagram is full width so its labels
 * stay near 1:1 (the page scrolls). Under it, the selection's detail — or
 * the net-change bars, once the reader clears — sits beside the Tiers table.
 * One selection drives all three. With no `?tier=` in the URL, the first
 * paint selects a band so the flow lines aren't blank. The chain comes from
 * the header selector.
 */
export const DistributionTerminal = ({ snapshot, snapshotError, selectedView, rangeDays }: Props) => {
  const { project } = useProject();
  const { t } = useProjectCopy();
  const { tiers: tierOrder } = useTierGeometry();
  const tk = project.ticker;
  const { data: historicalDelta } = useHolderHistoricalDelta({ view: selectedView, days: rangeDays, enabled: rangeDays >= 1 });
  const intro = useIntro();
  const chartIntro = useChartIntro();
  const [metric, setMetric] = useState<TierMetric>("wallets");
  // The selected tier rides in the URL (?tier=, replaceState: shareable, but
  // not a Back-button step per click). With no ?tier=, the first paint
  // selects a band (see defaultTierLabel) so the flow lines aren't blank.
  // "user" once the reader picks or clears — Clear must stay cleared.
  const urlTier = () => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tier") : null);
  const [selection, setSelection] = useState<DistSelection>(() => {
    const initial = urlTier();
    return initial ? { ...EMPTY_SELECTION, tier: initial } : EMPTY_SELECTION;
  });
  const choice = useRef<"auto" | "user">(urlTier() ? "user" : "auto");
  const dispatch = (a: DistAction) => {
    choice.current = "user";
    setSelection((s) => reduceSelection(s, a));
  };
  const onSelectionChange = useCallback((next: DistSelection) => {
    choice.current = "user";
    setSelection(next);
  }, []);
  const view = snapshot?.views[selectedView];
  // [] not null: with no history baseline for the range, drop the pipeline's
  // own previousCount (vs its last run, which can be weeks old) rather than
  // show it under a "1D"/"7D" label.
  const rows = useMemo(
    () => mergeDistributionBaseline(view?.distribution ?? [], historicalDelta?.distribution ?? []),
    [view, historicalDelta],
  );
  // † rule shared with the header KPIs and the Holders cards: when a
  // reclassification falls after this period's baseline, tier deltas mix
  // relabelling with real movement, so they're replaced by a † that says so.
  const { data: changelog } = useClassificationChangelog();
  const baselineMs = historicalDelta?.referenceDate ? Date.parse(historicalDelta.referenceDate) : NaN;
  const countRelabel = useMemo(
    () => (Number.isFinite(baselineMs) ? getEventsAffecting(changelog, "retail.count", baselineMs, Date.now()) : []),
    [changelog, baselineMs],
  );
  const balanceRelabel = useMemo(
    () => (Number.isFinite(baselineMs) ? getEventsAffecting(changelog, "retail.balance", baselineMs, Date.now()) : []),
    [changelog, baselineMs],
  );
  const countSuppressed = countRelabel.length > 0; // Tiers table "Change" columns only
  const balanceSuppressed = balanceRelabel.length > 0;
  // Net = wallets joined minus wallets left, per tier (owner decision 2026-10-31); the Tiers table keeps its snapshot-vs-baseline columns.
  const flowRows = useMemo(
    () => rows.map((r) => ({ label: r.label, count: r.count ?? 0, totalBalance: r.totalBalance ?? 0, previousCount: r.previousCount ?? null, previousTotalBalance: r.previousTotalBalance ?? null })),
    [rows],
  );
  const { fields: flowFields, ready: flowsReady, avail: flowAvail } = useFlowField(flowRows, chainKeyFor(selectedView), "wallets", rangeDays);
  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`;
  const selectedTier = selection.tier;
  const selected = hasSelection(selection);

  // First paint: pick a band once rows exist, unless the URL or the reader
  // already chose. A label the new chain doesn't have falls back the same way.
  useLayoutEffect(() => {
    if (!rows.length) return;
    const known = selection.tier != null && rows.some((r) => r.label === selection.tier);
    if (choice.current === "user" && (known || selection.tier == null)) return;
    if (choice.current === "user" && selection.tier && !known) choice.current = "auto";
    if (choice.current !== "auto") return;
    const label = defaultTierLabel(
      rows.map((r) => ({ label: r.label, count: r.count })),
      tierOrder,
    );
    if (!label || label === selection.tier) return;
    setSelection({ ...EMPTY_SELECTION, tier: label });
  }, [rows, selection.tier, tierOrder]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if ((url.searchParams.get("tier") ?? null) === (selectedTier ?? null)) return;
    if (selectedTier) url.searchParams.set("tier", selectedTier);
    else url.searchParams.delete("tier");
    window.history.replaceState(window.history.state, "", url);
  }, [selectedTier]);
  // Leaving Distribution drops the param: it only means something here.
  useEffect(
    () => () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("tier")) return;
      url.searchParams.delete("tier");
      window.history.replaceState(window.history.state, "", url);
    },
    [],
  );

  // Focus return: closing the detail (✕, Esc or Clear) unmounts the control
  // that had focus, which would drop it on <body>. Send it back to the tier the
  // reader picked — its Tiers-table button, else its diagram tile — or to the
  // diagram itself.
  const lastTier = useRef<string | null>(selectedTier);
  if (selectedTier) lastTier.current = selectedTier;
  const wasSelected = useRef(selected);
  const origin = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const was = wasSelected.current;
    wasSelected.current = selected;
    if (!was && selected) {
      const a = document.activeElement;
      origin.current = a instanceof HTMLElement && a !== document.body ? a : null;
      return;
    }
    if (!was || selected) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || !document.contains(active);
    // The rail is always mounted (ranked list when nothing is selected); only its selected state counts as "in detail".
    const inDetail = !!active?.closest?.('[data-testid="panel-tier-detail"][data-selected="true"], [data-testid="tier-flow"]');
    if (!lost && !inDetail) return;
    const tier = lastTier.current;
    const esc = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"'));
    const from = origin.current;
    origin.current = null;
    const target =
      (from && document.contains(from) && !from.closest('[data-testid="panel-tier-detail"]') ? from : null) ||
      (tier && document.querySelector<HTMLElement>(`[data-testid="panel-tiers"] tr[data-tier="${esc(tier)}"] button`)) ||
      (tier && document.querySelector<HTMLElement>(tierTileSelector(tier))) ||
      document.querySelector<HTMLElement>('[data-testid="tier-flow"]');
    if (!target) return;
    if (!target.hasAttribute("tabindex") && !/^(BUTTON|A|INPUT)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [selected]);

  // Escape also works when focus is in the table / bars, not only the diagram.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldClearOnEscape(e, document)) dispatch({ type: "clear" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  // Skipped (no zero-length bars) when the wallet-crossings feed is missing.
  const netByTier = netByTierRows(flowFields, flowsReady && flowAvail.hasTransitions);
  // Signed bars: zero baseline, fitted to the net changes, with extra headroom for end labels.
  const netScale = computeYAxisFromRows(netByTier, ["value"], { kind: "bar", headroom: NET_LABEL_HEADROOM });
  const netFmt = distinctTickFormatter(netScale.ticks, formatCompact);
  const netSizing = barSizing(netByTier.length);

  const placeholder = !snapshot ? (snapshotError ? <PanelError>Couldn't load the holder snapshot.</PanelError> : <PanelSkeleton />) : null;
  const detailTitle = selectedTier
    ? `${tierDisplayLabel(selectedTier)} tier`
    : selection.sideTile
      ? SIDE_TILE_LABELS[selection.sideTile.side][selection.sideTile.key]
      : "";

  // One-line announcement for screen readers. The detail panel itself is
  // not a live region: announcing its whole contents on every click was noise.
  const selectedRow = selectedTier ? rows.find((r) => r.label === selectedTier) : undefined;
  const liveSummary = selectedTier
    ? `${detailTitle} selected${
        selectedRow ? `: ${selectedRow.count.toLocaleString()} wallets` : ""
      }. Details in the panel; press Escape to close.`
    : selection.sideTile
      ? `${detailTitle} selected. Details in the panel; press Escape to close.`
      : "";


  return (
    <div className={`flex flex-col gap-3 ${intro ? "ha-stagger" : ""}`} data-testid="distribution-terminal">
      <TerminalPanel
        fit
        // overflow-visible: the detail rail inside is sticky, which a clipping ancestor would defeat.
        className="min-h-[36rem] !overflow-visible"
        title="Tier flows"
        info={`${t(TIER_FLOWS_EXPLAINER)}

Select a tier here or in the Tiers table to see where its wallets and ${tk} came from and went to over the period. Retail only; sub-1-${tk} dust wallets are counted in the lowest tier.`}
        stat={
          flowsReady && flowFields.length > 0 && (
            <span className="text-xs text-muted-foreground">{rangeLabel}</span>
          )
        }
        testId="panel-tier-flows"
      >
        {placeholder ? (
          <div className="min-h-[32rem]">{placeholder}</div>
        ) : rangeDays >= 1 ? (
            <TierFlowDiagram
              layout="terminal"
              chain={chainKeyFor(selectedView)}
              selection={selection}
              onSelectionChange={onSelectionChange}

              rangeDays={rangeDays}
              metric={metric}
              onMetricChange={setMetric}
              baselineDate={historicalDelta?.referenceDate ?? null}
              rows={rows.map((r) => ({
                label: r.label,
                count: r.count ?? 0,
                totalBalance: r.totalBalance ?? 0,
                previousCount: countSuppressed ? null : r.previousCount ?? null,
                previousTotalBalance: balanceSuppressed ? null : r.previousTotalBalance ?? null,
              }))}
            />
        ) : (
            <PanelMessage>Pick a range of at least one day to see tier flows.</PanelMessage>
        )}
      </TerminalPanel>

      <p className="sr-only" aria-live="polite" data-testid="tier-live-summary">
        {liveSummary}
      </p>
      {/* The selection's detail now lives in the Tier flows panel's right-hand rail,
          so the Tiers table takes the whole row. */}
      <div className="grid shrink-0 grid-cols-1 gap-3" data-testid="distribution-detail-row">
      <TerminalPanel
        fit
        title="Tiers"
        info={`Wallets and ${tk} per tier, with the change over the period, and each tier's share of retail ${tk}. Click a row to select that tier.`}
        flush
        testId="panel-tiers"
      >
        {placeholder ? (
          <div className="p-3">{placeholder}</div>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">Retail wallets and {tk} by balance tier. Select a tier to see its detail.</caption>
            <thead className="sticky top-0 z-[1] bg-card text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1 text-left font-medium">Tier ({tk})</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Wallets</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Change</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">{tk}</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Change</th>
                <th scope="col" className="px-3 py-1 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isSel = selectedTier === r.label;
                const dim = !!selectedTier && !isSel;
                return (
                  <tr
                    key={r.label}
                    aria-selected={isSel}
                    data-tier={r.label}
                    onClick={() => dispatch({ type: "tier-set", label: isSel ? null : r.label })}
                    className={`cursor-pointer border-t border-border/50 transition-colors ${
                      isSel ? "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]" : dim ? "text-muted-foreground hover:bg-muted/50" : "hover:bg-muted/50"
                    }`}
                  >
                    <th scope="row" className="whitespace-nowrap p-0 text-left font-medium">
                      <button
                        type="button"
                        aria-pressed={isSel}
                        aria-label={`${tierDisplayLabel(r.label)} tier${isSel ? ", selected" : ""}. ${isSel ? "Deselect" : "Show detail"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({ type: "tier-set", label: isSel ? null : r.label });
                        }}
                        className={`flex min-h-[24px] w-full items-center px-3 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${isSel ? "font-semibold text-primary" : ""}`}
                      >
                        {tierDisplayLabel(r.label)}
                      </button>
                    </th>
                    <td className="px-2 py-1 text-right">{int.format(r.count)}</td>
                    <td className="px-2 py-1 text-right">
                      <Delta value={r.previousCount != null ? r.count - r.previousCount : null} format={(n) => int.format(n)} relabel={countRelabel} />
                    </td>
                    <td className="px-2 py-1 text-right">{formatCompact(r.totalBalance)}</td>
                    <td className="px-2 py-1 text-right">
                      <Delta value={r.previousTotalBalance != null ? r.totalBalance - r.previousTotalBalance : null} format={(n) => formatCompact(n, 1)} relabel={balanceRelabel} />
                    </td>
                    <td className="px-3 py-1 text-right">{r.percent.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TerminalPanel>
      </div>
      {/* Nothing to expand until the period's flows have loaded. */}
      {netByTier.some((d) => d.has) && (
      <Accordion type="single" collapsible className="shrink-0" data-testid="distribution-details">
        <AccordionItem value="details" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="py-3 text-sm font-semibold">Details: net wallet change by tier</AccordionTrigger>
          <AccordionContent>
            {chainKeyFor(selectedView) !== "all" && (
              <p className="mb-2 text-xs text-muted-foreground" data-testid="net-change-chain-note">{ALL_CHAIN_CROSSINGS_NOTE}</p>
            )}
            <TerminalPanel
              chart="standard"
              title="Net wallet change by tier"
              info="Wallets that joined each tier minus wallets that left it over the period. Click a bar to select that tier."
              testId="panel-net-change"
            >
              {placeholder ??
                (netByTier.some((d) => d.has) ? (
                  <div
                    role="img"
                    aria-label={`Net wallet change by tier: ${netByTier.map((d) => `${d.name} ${signedInt(d.value)}`).join(", ")}. Select a tier in the Tiers table to see its detail.`}
                    className="h-full w-full [&_.recharts-bar-rectangle]:cursor-pointer"
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={netByTier} layout="vertical" barCategoryGap={netSizing.barCategoryGap} margin={{ top: 2, right: 16, bottom: 0, left: 0 }}>
                        <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                        <XAxis
                          type="number"
                          // Fitted to the bars, with extra headroom so the value labels at the bar ends fit.
                          domain={netScale.domain}
                          ticks={netScale.ticks}
                          tick={CHART_TICK}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={netFmt}
                        />
                        <YAxis type="category" dataKey="name" width={84} tick={CHART_TICK} tickLine={false} axisLine={false} interval={0} />
                        <Tooltip
                          cursor={{ fill: "hsl(var(--muted))" }}
                          formatter={(v: number) => [signedInt(v), "Net wallets"]}
                          contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 14 }}
                          labelStyle={{ color: "hsl(var(--popover-foreground))" }}
                          itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                        />
                        <Bar
                          dataKey="value"
                          maxBarSize={netSizing.maxBarSize}
                          minPointSize={netSizing.minPointSize}
                          isAnimationActive={chartIntro}
                          animationDuration={CHART_DRAW_MS}
                          radius={2}
                          // A transparent full-row background takes the same click,
                          // so a near-zero bar (a few px wide) is still a real target.
                          background={{ fill: "transparent", cursor: "pointer" }}
                          className="cursor-pointer"
                          onClick={(d: { label?: string }) => d?.label && dispatch({ type: "tier-set", label: d.label })}
                        >
                          {netByTier.map((d) => (
                            <Cell key={d.label} fill={d.value >= 0 ? "hsl(var(--ha-positive))" : "hsl(var(--ha-negative))"} />
                          ))}
                          <LabelList dataKey="value" content={NetBarLabel} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <PanelMessage>No baseline for this period yet.</PanelMessage>
                ))}
            </TerminalPanel>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      )}
    </div>
  );
};
