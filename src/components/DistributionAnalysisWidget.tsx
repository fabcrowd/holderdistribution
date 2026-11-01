import { useState } from "react";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { useProject } from "@/hooks/useProject";
import { chainViewLabel } from "@/lib/chainViews";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { BarChart3 } from "lucide-react";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { type HolderLiteSnapshot, type DisplaySelection } from "@/hooks/useHolderSnapshot";
import { useHolderHistoricalDelta } from "@/hooks/useHolderHistoricalDelta";
import { useClassificationChangelog, getEventsAffecting } from "@/hooks/useClassificationChangelog";
import { mergeDistributionBaseline, summarizeTierGrowth } from "@/lib/distributionRows";
import { TierFlowDiagram, type TierMetric } from "@/components/TierFlowDiagram";
import { useMediaQuery, PHONE_QUERY } from "@/hooks/useMediaQuery";
import { tierDisplayLabel } from "@/components/tierflow/geometry";
import { bucketFloor } from "@/lib/holderTiers";
import { DexSwaps } from "@/components/DexSwaps";
import { MethodologyInfo } from "@/components/MethodologyInfo";
import { InfoTooltip } from "@/components/InfoTooltip";
import { RANGE_OPTIONS } from "@/lib/timeRange";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid } from "recharts";
import "@/lib/rechartsMotion";
import { CHART_HEIGHT_CLASS, CHART_TICK } from "@/lib/terminalLayout";
import { barSizing, computeYAxisFromRows } from "@/lib/chartAxes";

type DistributionAnalysisWidgetProps = {
  snapshot: HolderLiteSnapshot | null;
  selectedView: DisplaySelection;
  rangeDays?: number;
  onRangeDaysChange?: (days: number) => void;
  /** Lets this widget reset the page-wide chain scope back to Combined. See
   *  the "scoped, no way back" note above `hasUnifiedChart`. */
  onViewChange?: (view: DisplaySelection) => void;
};


const formatTokenAmount = (value: number) => {
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (absolute >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
};

const formatInteger = (value: number) => new Intl.NumberFormat().format(value);

const formatPercentage = (value: number, digits = 2) => `${value.toFixed(digits)}%`;

const DistributionAnalysisWidget = ({
  snapshot,
  selectedView,
  rangeDays,
  onRangeDaysChange,
  onViewChange,
}: DistributionAnalysisWidgetProps) => {
  const { ticker, tiers } = useProjectCopy();
  const { project } = useProject();
  const dustFloor = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(bucketFloor(tiers));
  // Range-aware baseline: history distribution at the start of the selected
  // window (combined view only — chain views keep the snapshot baseline).
  const { data: historicalDelta } = useHolderHistoricalDelta({
    view: selectedView,
    days: rangeDays ?? 0,
    enabled: (rangeDays ?? 0) >= 1,
  });
  const { data: changelog } = useClassificationChangelog();

  // Which metric the chart bars show. Driven by the toggle *and* by clicking
  // the Holders / Total Balance column headers in the table below.
  const [metric, setMetric] = useState<TierMetric>("wallets");
  // Combined-view only (tiers are cross-chain by construction — chain views
  // have no meaningful per-tier transition data). All timeframe keys —
  // including 1D — resolve via outflowsKeyFor/transitionsKeyFor to matching
  // "1"/"7"/… buckets in both JSON files.
  const tierFlowsOnPage = selectedView === "combined" && (rangeDays ?? 0) >= 1;
  // Phones use the stacked chart + table for every view (the Ethereum layout);
  // the tier-flow diagram then sits below the table instead of replacing it.
  const isPhone = useMediaQuery(PHONE_QUERY);
  const hasUnifiedChart = tierFlowsOnPage && !isPhone;

  if (!snapshot) return null;

  const view = snapshot.views[selectedView];
  if (!view) return null;
  const baseRows = view?.distribution ?? [];
  // [] not null: with no history baseline for the range, drop the
  // pipeline's own previousCount (vs its last run, which can be weeks old)
  // instead of showing it under a "1D"/"7D" label.
  const rows = mergeDistributionBaseline(baseRows, historicalDelta?.distribution ?? []);

  if (rows.length === 0) return null;

  // Per-tier holder/balance deltas come from the same reclassifiable retail
  // set as the headline retail.count/retail.balance figures — a
  // reclassification between the baseline date and now (e.g. the KuCoin
  // vault relabel) means a tier's count/balance jump is a bookkeeping
  // artifact, not real accumulation. See ChangeIndicator's changelogEvents.
  const distributionBaselineMs = historicalDelta?.referenceDate ? Date.parse(historicalDelta.referenceDate) : NaN;
  const nowMs = Date.now();
  const distributionCountEvents = Number.isFinite(distributionBaselineMs)
    ? getEventsAffecting(changelog, "retail.count", distributionBaselineMs, nowMs)
    : [];
  const distributionBalanceEvents = Number.isFinite(distributionBaselineMs)
    ? getEventsAffecting(changelog, "retail.balance", distributionBaselineMs, nowMs)
    : [];

  const chartData = rows.map((row) => ({
    range: tierDisplayLabel(row.label),
    percent: row.percent ?? 0,
    count: row.count ?? 0,
    // Tier gained holders over the selected window (null baseline = no comparison)
    gained: (row.previousCount ?? null) !== null ? row.count > (row.previousCount ?? 0) : null,
  }));

  const percentY = computeYAxisFromRows(chartData, ["percent"], { kind: "bar" });
  const percentSizing = barSizing(chartData.length);
  const distributionChartConfig = {
    percent: { label: "% of Retail", color: "hsl(var(--primary))" },
    count: { label: "Wallets", color: "hsl(var(--muted-foreground))" },
  };

  // Broad-accumulation signal: how many tiers gained holders over the window.
  const { tiers: tiersWithBaselineCount, grew: tiersGrew, netWallets: netNewHolders } = summarizeTierGrowth(rows);
  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label;
  // † rule: the "N of M tiers gained" summary is itself a tier delta.
  const showAccumulation = tiersWithBaselineCount > 0 && rangeLabel && distributionCountEvents.length === 0;

  // Scope + dust note: lives in the (i) beside the chart title (floors at the
  // project's lowest tier; see scripts/lib/holdersView.js reconcileDistributionCounts).
  const scopeNote = `Retail only, excluding exchange & hot wallets. Sub-${dustFloor}-${ticker} dust wallets are counted in the lowest tier.`;

  const tierFlow = (
    <TierFlowDiagram
      infoPrefix={scopeNote}
      rangeDays={rangeDays ?? 0}
      metric={metric}
      onMetricChange={setMetric}
      baselineDate={historicalDelta?.referenceDate ?? null}
      rows={rows.map((r) => ({
        label: r.label,
        count: r.count ?? 0,
        totalBalance: r.totalBalance ?? 0,
        previousCount: distributionCountEvents.length ? null : r.previousCount ?? null,
        previousTotalBalance: distributionBalanceEvents.length ? null : r.previousTotalBalance ?? null,
      }))}
    />
  );

  return (
    <Card className="premium-surface-card">
      {/* No Collapsible: sole content of the "Distribution" tab, so the tab
          already does the showing and hiding. */}
      <CardHeader className="holders-header-distribution">
          <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2 flex-wrap">
            <span className="p-1.5 rounded-xl bg-primary/10 border border-primary/20 shrink-0">
              <BarChart3 className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
            </span>
            Distribution Analysis
            <MethodologyInfo section="distribution" />
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 mt-1.5 empty:hidden">
            {/* This tab has no chain selector of its own — `selectedView` is
                set on the Holders tab and carries over silently, and picking
                a chain there also swaps this tab's whole visualization
                (TierFlowDiagram -> a plain bar chart, since chain views have
                no tier-transition data to animate). Landing here scoped to
                one chain with no visible sign of it, and no way back short
                of returning to Holders, is confusing — this badge is both
                the indicator and the escape hatch. */}
            {selectedView !== "combined" && (
              <button
                type="button"
                onClick={() => onViewChange?.("combined")}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning border border-warning/40 bg-warning-tint rounded-full px-2 py-0.5 min-h-[28px] hover:bg-warning-tint/80 transition-colors"
              >
                Showing {chainViewLabel(project, selectedView)} only
                <span className="underline">View all chains</span>
              </button>
            )}
          </div>
      </CardHeader>
          <CardContent className="p-0 space-y-6">
            {showAccumulation && (
              <div className="mx-4 mt-4 sm:mx-6 rounded-2xl border border-border/50 bg-muted/20 px-5 py-4 text-center">
                <div className="text-2xl font-bold text-foreground">
                  {tiersGrew} of {tiersWithBaselineCount} tiers gained holders
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {netNewHolders >= 0 ? "+" : ""}{formatInteger(netNewHolders)} net retail wallets across all tiers over {rangeLabel}
                </div>
              </div>
            )}
            {/* One combined pane: distribution bars + the movement story on hover.
                Chain views have no tier-transition data, so they keep the plain
                bar chart. */}
            {hasUnifiedChart ? (
              <div className="px-4 pt-4 sm:px-6">
                {tierFlow}
              </div>
            ) : (
              <div className="px-4 pt-4 sm:px-6">
                <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-3 flex items-center justify-center gap-1.5">
                  % of retail by balance range
                  <InfoTooltip text={scopeNote} label="About this chart" className="max-xl:before:-inset-2.5" />
                </p>
                {chartData.some((d) => d.gained !== null) && (
                  <p className="mb-2 flex items-center justify-center gap-4 text-[13px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-positive" />Tier gained wallets</span>
                    <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-muted-foreground/50" />No gain</span>
                  </p>
                )}
                <ChartContainer config={distributionChartConfig} className={`${CHART_HEIGHT_CLASS.standard} w-full`}>
                  <BarChart data={chartData} margin={{ top: 12, right: 12, bottom: 28, left: 12 }} barCategoryGap={percentSizing.barCategoryGap}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                    <XAxis dataKey="range" tick={CHART_TICK} interval={0} angle={-35} textAnchor="end" height={48} />
                    <YAxis tick={CHART_TICK} tickFormatter={(v) => `${v}%`} domain={percentY.domain} ticks={percentY.ticks} />
                    <ChartTooltip content={<ChartTooltipContent />} formatter={(value: number) => [`${value.toFixed(2)}%`, "% of retail"]} />
                    <Bar dataKey="percent" radius={[4, 4, 0, 0]} maxBarSize={percentSizing.maxBarSize} minPointSize={percentSizing.minPointSize}>
                      {chartData.map((entry) => (
                        <Cell
                          key={entry.range}
                          fill={
                            entry.gained === null
                              ? "hsl(var(--primary) / 0.8)"
                              : entry.gained
                                ? "hsl(var(--ha-positive))"
                                : "hsl(var(--muted-foreground) / 0.5)"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </div>
            )}
            {/* The unified chart above is now a single interactive table —
                each row IS the bar, the holder/balance/percent columns, and
                (expanded) the cause breakdown, all in one place. Repeating a
                second plain table below it here would just restate the same
                numbers a second time. Chain views don't get the unified chart
                (no tier-transition data), so they keep a plain table alongside
                their simpler bar chart above. */}
            {!hasUnifiedChart && (
            <div className="overflow-x-auto -webkit-overflow-scrolling-touch">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="text-center font-semibold text-muted-foreground text-xs sm:text-sm px-2 sm:px-4">Range ({ticker})</TableHead>
                    <TableHead className="text-center px-2 sm:px-4">
                      <span className="font-semibold text-muted-foreground text-xs sm:text-sm">Holders</span>
                    </TableHead>
                    <TableHead className="text-center px-2 sm:px-4">
                      <span className="font-semibold text-muted-foreground text-xs sm:text-sm">Total Balance</span>
                    </TableHead>
                    <TableHead className="text-center font-semibold text-muted-foreground text-xs sm:text-sm px-2 sm:px-4">% of Retail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.label} className="hover:bg-muted/20 transition-colors">
                      <TableCell className="font-medium text-center text-xs sm:text-sm px-2 sm:px-4 whitespace-nowrap">{tierDisplayLabel(row.label)}</TableCell>
                      <TableCell className="text-center text-xs sm:text-sm px-2 sm:px-4">
                        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
                          {formatInteger(row.count)}
                          <ChangeIndicator current={row.count} previous={row.previousCount ?? null} changelogEvents={distributionCountEvents} variant={distributionCountEvents.length ? "plain" : "pill"} />
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-xs sm:text-sm px-2 sm:px-4">
                        <div className={`flex items-center justify-center gap-x-2 gap-y-0.5 ${distributionBalanceEvents.length ? "flex-nowrap" : "flex-wrap"}`}>
                          <span className="whitespace-nowrap">{formatTokenAmount(row.totalBalance)}</span>
                          <ChangeIndicator
                            current={row.totalBalance}
                            previous={row.previousTotalBalance ?? null}
                            formatter={formatTokenAmount}
                            changelogEvents={distributionBalanceEvents}
                            variant={distributionBalanceEvents.length ? "plain" : "pill"}
                          />
                          {/* percentage change repeats the same delta as the
                              amount chip — keep it for larger screens only,
                              it was crowding this cell off narrow viewports */}
                          <span className={distributionBalanceEvents.length ? "hidden" : "hidden sm:inline-flex"}>
                            <ChangeIndicator
                              current={row.totalBalance}
                              previous={row.previousTotalBalance ?? null}
                              mode="percentage"
                              precision={2}
                              changelogEvents={distributionBalanceEvents}
                            />
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-xs sm:text-sm px-2 sm:px-4 whitespace-nowrap">
                        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
                          {formatPercentage(row.percent, 2)}
                          {/* Share of the retail pool, not a gain/loss of TEL
                              (that's the Total Balance column) — a tier's
                              share can shrink even while it holds more TEL,
                              if other tiers grew faster. Plain "was X%"
                              instead of a "pp" delta, which isn't an
                              abbreviation most readers would recognize. */}
                          {row.previousPercent != null && (
                            <span className="text-muted-foreground">(was {row.previousPercent.toFixed(2)}%)</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            )}
            {!hasUnifiedChart && (distributionCountEvents.length > 0 || distributionBalanceEvents.length > 0) && (
              <p className="px-4 text-xs text-muted-foreground sm:px-6">† Change vs. baseline not shown: wallets were reclassified.</p>
            )}
            {/* TierFlowDiagram's own header already shows the whole-market DEX
                figure (sourced the same way, from useExchangeFlow, matching
                whatever range is selected) whenever the unified chart is
                showing — repeating this block there would just restate it.
                Chain views keep the plain bar chart and need this fallback. */}
            {selectedView === "combined" && !tierFlowsOnPage && (
              <div className="px-4 pb-6 sm:px-6">
                <DexSwaps rangeDays={rangeDays ?? 0} />
              </div>
            )}
            {/* Phone: the tier-flow diagram follows the stacked chart and table. */}
            {isPhone && tierFlowsOnPage && (
              <div className="px-4 pb-6 sm:px-6">{tierFlow}</div>
            )}
          </CardContent>
    </Card>
  );
};

export default DistributionAnalysisWidget;
