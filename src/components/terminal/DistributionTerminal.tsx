import { useEffect, useMemo, useRef, useState } from "react";
import { useChartIntro, useIntro } from "@/hooks/useMotion";
import { CHART_DRAW_MS } from "@/lib/motion";
import { signedInt } from "@/lib/format";
import { X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DisplaySelection, HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { useHolderHistoricalDelta } from "@/hooks/useHolderHistoricalDelta";
import { useClassificationChangelog, getEventsAffecting } from "@/hooks/useClassificationChangelog";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { TierFlowDiagram, type TierMetric } from "@/components/TierFlowDiagram";
import { tierDisplayLabel } from "@/components/tierflow/geometry";
import { SIDE_TILE_LABELS } from "@/components/tierflow/netFlow";
import type { ChainKey } from "@/components/tierflow/useFlowField";
import { mergeDistributionBaseline, summarizeTierGrowth } from "@/lib/distributionRows";
import {
  EMPTY_SELECTION, hasSelection, reduceSelection, shouldClearOnEscape, type DistAction, type DistSelection,
} from "@/lib/distributionSelection";
import { RANGE_OPTIONS } from "@/lib/timeRange";
import { formatCompact } from "@/lib/format";
import { TerminalPanel, PanelMessage, PanelError, PanelSkeleton, Delta } from "./TerminalPanel";

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
      fontSize={10}
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
 * Desktop Distribution view. One selection drives all three panels: pick a
 * tier on the diagram, in the Tiers table or on the net-change bars and it
 * highlights everywhere, and the right-hand top panel turns into that tier's
 * detail (✕ / Esc to close). The chain comes from the header selector.
 */
export const DistributionTerminal = ({ snapshot, snapshotError, selectedView, rangeDays }: Props) => {
  const { data: historicalDelta } = useHolderHistoricalDelta({ view: selectedView, days: rangeDays, enabled: rangeDays >= 1 });
  const intro = useIntro();
  const chartIntro = useChartIntro();
  const [metric, setMetric] = useState<TierMetric>("wallets");
  // The selected tier rides in the URL (?tier=, replaceState: shareable, but
  // not a Back-button step per click).
  const [selection, setSelection] = useState<DistSelection>(() => {
    const t = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tier") : null;
    return t ? { ...EMPTY_SELECTION, tier: t } : EMPTY_SELECTION;
  });
  const dispatch = (a: DistAction) => setSelection((s) => reduceSelection(s, a));
  const [detailEl, setDetailEl] = useState<HTMLDivElement | null>(null);
  const view = snapshot?.views[selectedView];
  const rows = useMemo(
    () => mergeDistributionBaseline(view?.distribution ?? [], historicalDelta?.distribution ?? null),
    [view, historicalDelta],
  );
  const growth = summarizeTierGrowth(rows);
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
  const countSuppressed = countRelabel.length > 0;
  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`;
  const selectedTier = selection.tier;
  const selected = hasSelection(selection);

  // A tier that doesn't exist on the newly chosen chain can't stay selected.
  useEffect(() => {
    if (selectedTier && rows.length && !rows.some((r) => r.label === selectedTier)) dispatch({ type: "clear" });
  }, [rows, selectedTier]);

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
    const inDetail = !!active?.closest?.('[data-testid="panel-tier-detail"], [data-testid="tier-flow"]');
    if (!lost && !inDetail) return;
    const tier = lastTier.current;
    const esc = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"'));
    const from = origin.current;
    origin.current = null;
    const target =
      (from && document.contains(from) && !from.closest('[data-testid="panel-tier-detail"]') ? from : null) ||
      (tier && document.querySelector<HTMLElement>(`[data-testid="panel-tiers"] tr[data-tier="${esc(tier)}"] button`)) ||
      (tier && document.querySelector<HTMLElement>(`[data-testid="tier-flow"] [data-tier="${esc(tier)}"]`)) ||
      document.querySelector<HTMLElement>('[data-testid="tier-flow"]');
    if (!target) return;
    if (!target.hasAttribute("tabindex") && !/^(BUTTON|A|INPUT)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [selected]);

  // Escape also works when focus is in the table / bars, not only the diagram.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldClearOnEscape(e, document)) setSelection(EMPTY_SELECTION);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  const netByTier = rows.map((r) => ({
    label: r.label,
    name: tierDisplayLabel(r.label),
    value: r.previousCount != null ? r.count - r.previousCount : 0,
    has: r.previousCount != null,
  }));

  const placeholder = !snapshot ? (snapshotError ? <PanelError>Couldn't load the holder snapshot.</PanelError> : <PanelSkeleton />) : null;
  const detailTitle = selectedTier
    ? `${tierDisplayLabel(selectedTier)} tier`
    : selection.sideTile
      ? SIDE_TILE_LABELS[selection.sideTile.side][selection.sideTile.key]
      : "";

  const closeButton = (
    <button
      type="button"
      onClick={() => setSelection(EMPTY_SELECTION)}
      aria-label="Close tier detail (Esc)"
      title="Close (Esc)"
      data-testid="tier-detail-close"
      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );

  return (
    <div className={`grid h-full min-h-0 grid-cols-12 grid-rows-2 gap-2 ${intro ? "ha-stagger" : ""}`} data-testid="distribution-terminal">
      <TerminalPanel
        className="col-span-7 row-span-2"
        title="Tier flows"
        info="Each bar is a retail balance tier. Select a tier (here, in the Tiers table or on the bars) to see where its wallets and TEL came from and went to over the period. Retail only; sub-1-TEL dust wallets are counted in the lowest tier."
        stat={
          growth.tiers > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {growth.grew} of {growth.tiers}
              </span>{" "}
              tiers gained wallets · <Delta value={growth.netWallets} format={(n) => int.format(n)} relabel={countRelabel} /> net over {rangeLabel}
            </span>
          )
        }
        testId="panel-tier-flows"
      >
        {placeholder ??
          (rangeDays >= 1 ? (
            <TierFlowDiagram
              layout="terminal"
              chain={chainKeyFor(selectedView)}
              selection={selection}
              onSelectionChange={setSelection}
              detailContainer={detailEl}
              rangeDays={rangeDays}
              metric={metric}
              onMetricChange={setMetric}
              baselineDate={historicalDelta?.referenceDate ?? null}
              rows={rows.map((r) => ({
                label: r.label,
                count: r.count ?? 0,
                totalBalance: r.totalBalance ?? 0,
                previousCount: r.previousCount ?? null,
                previousTotalBalance: r.previousTotalBalance ?? null,
              }))}
            />
          ) : (
            <PanelMessage>Pick a range of at least one day to see tier flows.</PanelMessage>
          ))}
      </TerminalPanel>

      {selected ? (
        <TerminalPanel
          className="col-span-5"
          title={detailTitle}
          info="Detail for the selection on the tier diagram. Close with ✕ or Esc."
          actions={closeButton}
          testId="panel-tier-detail"
        >
          <div ref={setDetailEl} className="min-h-full" aria-live="polite" />
        </TerminalPanel>
      ) : (
        <TerminalPanel
          className="col-span-5"
          title="Net wallet change by tier"
          info="Retail wallets in each tier now, minus at the start of the period. Click a bar to select that tier."
          testId="panel-net-change"
        >
          {placeholder ??
            (countSuppressed && netByTier.some((d) => d.has) ? (
              <PanelMessage>
                <span data-testid="net-change-relabelled">
                  <ChangeIndicator variant="plain" current={0} previous={0} changelogEvents={countRelabel} className="mr-1 text-xs" />
                  Net change isn&apos;t shown: wallets were reclassified after this period&apos;s baseline
                  {historicalDelta?.referenceDate ? ` (${historicalDelta.referenceDate})` : ""}, so tier counts would mix relabelling
                  with real moves.
                </span>
              </PanelMessage>
            ) : netByTier.some((d) => d.has) ? (
              <div
                role="img"
                aria-label={`Net wallet change by tier: ${netByTier.map((d) => `${d.name} ${signedInt(d.value)}`).join(", ")}. Select a tier in the Tiers table to see its detail.`}
                className="h-full w-full [&_.recharts-bar-rectangle]:cursor-pointer"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={netByTier} layout="vertical" margin={{ top: 2, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                    <XAxis
                      type="number"
                      // Headroom on both sides so the value labels at the bar ends fit.
                      domain={[(min: number) => (min < 0 ? Math.floor(min * 1.3) : 0), (max: number) => (max > 0 ? Math.ceil(max * 1.3) : 0)]}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => formatCompact(v, 1)}
                    />
                    <YAxis type="category" dataKey="name" width={72} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--muted))" }}
                      formatter={(v: number) => [signedInt(v), "Net wallets"]}
                      contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }}
                      labelStyle={{ color: "hsl(var(--popover-foreground))" }}
                      itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                    />
                    <Bar
                      dataKey="value"
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
      )}

      <TerminalPanel
        className="col-span-5"
        title="Tiers"
        info="Wallets and TEL per tier, with the change over the period, and each tier's share of retail TEL. Click a row to select that tier."
        flush
        testId="panel-tiers"
      >
        {placeholder ? (
          <div className="h-full p-2">{placeholder}</div>
        ) : (
          <table className="w-full text-xs tabular-nums">
            <caption className="sr-only">Retail wallets and TEL by balance tier. Select a tier to see its detail.</caption>
            <thead className="sticky top-0 z-[1] bg-card text-[11px] text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1 text-left font-medium">Tier (TEL)</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Wallets</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Change</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">TEL</th>
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
  );
};
