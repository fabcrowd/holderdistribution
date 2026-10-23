import { useState } from "react";
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
import { tierDisplayLabel } from "@/components/tierflow/geometry";
import { DexSwaps } from "@/components/DexSwaps";
import { MethodologyInfo } from "@/components/MethodologyInfo";
import { RANGE_OPTIONS } from "@/lib/timeRange";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid } from "recharts";
import "@/lib/rechartsMotion";

type DistributionAnalysisWidgetProps = {
  snapshot: HolderLiteSnapshot | null;
  selectedView: DisplaySelection;
  rangeDays?: number;
  onRangeDaysChange?: (days: number) => void;
  /** Lets this widget reset the page-wide chain scope back to Combined. See
   *  the "scoped, no way back" note above `hasUnifiedChart`. */
  onViewChange?: (view: DisplaySelection) => void;
};

const CHAIN_LABEL: Record<DisplaySelection, string> = {
  combined: "Combined",
  ethereum: "Ethereum",
  polygon: "Polygon",
  base: "Base",
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
  const hasUnifiedChart = selectedView === "combined" && (rangeDays ?? 0) >= 1;

  if (!snapshot) return null;

  const view = snapshot.views[selectedView];
  if (!view) return null;
  const baseRows = view?.distribution ?? [];
  const rows = mergeDistributionBaseline(baseRows, historicalDelta?.distribution ?? null);

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

  const distributionChartConfig = {
    percent: { label: "% of Retail", color: "hsl(var(--primary))" },
    count: { label: "Holders", color: "hsl(var(--muted-foreground))" },
  };

  // Broad-accumulation signal: how many tiers gained holders over the window.
  const { tiers: tiersWithBaselineCount, grew: tiersGrew, netWallets: netNewHolders } = summarizeTierGrowth(rows);
  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label;
  // † rule: the "N of M tiers gained" summary is itself a tier delta.
  const showAccumulation = tiersWithBaselineCount > 0 && rangeLabel && distributionCountEvents.length === 0;

  return (
    <Card className="premium-surface-card">
      {/* No Collapsible: sole content of the "Distribution" tab, so the tab
          already does the showing and hiding. */}
      <CardHeader className="holders-header-distribution">
          <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2 flex-wrap">
            <span className="p-1.5 rounded-xl bg-violet-500/12 border border-violet-500/20 shrink-0">
              <BarChart3 className="h-4 w-4 sm:h-5 sm:w-5 text-violet-600 dark:text-violet-400" />
            </span>
            Distribution Analysis
            <MethodologyInfo section="distribution" />
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <span className="text-[10px] sm:text-xs font-medium text-muted-foreground border border-border/60 rounded-full px-2 py-0.5">
              Retail only — excludes exchange &amp; hot wallets
            </span>
            {/* Buckets floor at 1 TEL by design — sub-1-TEL dust wallets
                never land in their true tier by balance, since it can't be
                determined without a full transfer replay. Their COUNT is
                folded into the lowest tier ("1-250K") so tier counts still
                sum to the headline Retail Holders count above (see
                scripts/lib/holdersView.js's buildViewData /
                reconcileDistributionCounts); their balance is not reflected
                anywhere (dust is <1 TEL each, immaterial). See lessons.md
                "Sub-1-TEL Dust Wallets Are Deliberately Excluded From
                Buckets, Not Counts". */}
            <span className="text-[10px] sm:text-xs font-medium text-muted-foreground border border-border/60 rounded-full px-2 py-0.5">
              Sub-1-TEL dust wallets counted in lowest tier
            </span>
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
                className="inline-flex items-center gap-1.5 text-[10px] sm:text-xs font-semibold text-amber-700 dark:text-amber-400 border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 rounded-full px-2 py-0.5 min-h-[28px] hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
              >
                Showing {CHAIN_LABEL[selectedView]} only
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
                  {netNewHolders >= 0 ? "+" : ""}{formatInteger(netNewHolders)} net retail holders across all tiers over {rangeLabel}
                </div>
              </div>
            )}
            {/* One combined pane: distribution bars + the movement story on hover.
                Chain views have no tier-transition data, so they keep the plain
                bar chart. */}
            {hasUnifiedChart ? (
              <div className="px-4 pt-4 sm:px-6">
                <TierFlowDiagram
                  rangeDays={rangeDays ?? 0}
                  metric={metric}
                  onMetricChange={setMetric}
                  baselineDate={historicalDelta?.referenceDate ?? null}
                  // † rule (same as the desktop terminal): no tier deltas on
                  // the diagram when a reclassification follows the baseline.
                  suppressedNote={{
                    count: distributionCountEvents.length ? "† not shown (wallets reclassified since baseline)" : null,
                    balance: distributionBalanceEvents.length ? "† not shown (wallets reclassified since baseline)" : null,
                  }}
                  rows={rows.map((r) => ({
                    label: r.label,
                    count: r.count ?? 0,
                    totalBalance: r.totalBalance ?? 0,
                    previousCount: distributionCountEvents.length ? null : r.previousCount ?? null,
                    previousTotalBalance: distributionBalanceEvents.length ? null : r.previousTotalBalance ?? null,
                  }))}
                />
              </div>
            ) : (
              <div className="px-4 pt-4 sm:px-6">
                <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-3 text-center">% of retail by balance range</p>
                <ChartContainer config={distributionChartConfig} className="h-[220px] w-full sm:h-[280px]">
                  <BarChart data={chartData} margin={{ top: 12, right: 12, bottom: 24, left: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                    <XAxis dataKey="range" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                    <ChartTooltip content={<ChartTooltipContent />} formatter={(value: number) => [`${value.toFixed(2)}%`, "% of retail"]} />
                    <Bar dataKey="percent" radius={[4, 4, 0, 0]}>
                      {chartData.map((entry) => (
                        <Cell
                          key={entry.range}
                          fill={
                            entry.gained === null
                              ? "hsl(var(--primary) / 0.8)"
                              : entry.gained
                                ? "hsl(142 71% 45%)"
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
                    <TableHead className="text-center font-semibold text-muted-foreground text-xs sm:text-sm px-2 sm:px-4">Range (TEL)</TableHead>
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
                          <ChangeIndicator current={row.count} previous={row.previousCount ?? null} changelogEvents={distributionCountEvents} />
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-xs sm:text-sm px-2 sm:px-4">
                        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
                          <span className="whitespace-nowrap">{formatTokenAmount(row.totalBalance)}</span>
                          <ChangeIndicator
                            current={row.totalBalance}
                            previous={row.previousTotalBalance ?? null}
                            formatter={formatTokenAmount}
                            changelogEvents={distributionBalanceEvents}
                          />
                          {/* percentage change repeats the same delta as the
                              amount chip — keep it for larger screens only,
                              it was crowding this cell off narrow viewports */}
                          <span className="hidden sm:inline-flex">
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
            {/* TierFlowDiagram's own header already shows the whole-market DEX
                figure (sourced the same way, from useExchangeFlow, matching
                whatever range is selected) whenever the unified chart is
                showing — repeating this block there would just restate it.
                Chain views keep the plain bar chart and need this fallback. */}
            {selectedView === "combined" && !hasUnifiedChart && (
              <div className="px-4 pb-6 sm:px-6">
                <DexSwaps rangeDays={rangeDays ?? 0} />
              </div>
            )}
          </CardContent>
    </Card>
  );
};

export default DistributionAnalysisWidget;
