import { ToggleableSeries } from "@/components/chart/ToggleableSeries";
import type { LegendItem } from "@/components/chart/ChartLegend";
import { useMemo, useState, Fragment, type ReactNode } from "react";
import { useProjectCopy, type UseProjectCopy } from "@/hooks/useProjectCopy";
import { useProject } from "@/hooks/useProject";
import type { TierRange } from "@/lib/holderTiers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SubPanelTabs } from "@/components/SubPanelTabs";
import { HOLDER_EXPLORE_PANELS } from "@/lib/terminalCopy";
import { formatSourceLabel, formatCompact } from "@/lib/format";
import { v3StakingGapEvents } from "@/lib/staking";
import { barSizing, computeYAxisFromRows } from "@/lib/chartAxes";
import { TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Activity,
  Banknote,
  Building2,
  ChevronDown,
  ChevronRight,
  Database,
  Globe2,
  Layers,
  Loader2,
  RefreshCw,
  Users,
  type LucideIcon,
} from "lucide-react";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import {
  useHolderLiteSnapshot,
  type HolderLiteSnapshot,
  type HolderLiteView,
  type HolderMetrics,
  type CexFlowSnapshot,
  type CexExchangeTotals,
  type CexExchangeWallet,
} from "@/hooks/useHolderSnapshot";
import { useUserRole } from "@/hooks/useUserRole";
import { CexHistoryTiles } from "@/components/CexHistoryTiles";
import { useCexBalanceHistory, type CexHistoryEntry } from "@/hooks/useCexBalanceHistory";
import { useHolderGrowth } from "@/hooks/useHolderGrowth";
import { RANGE_OPTIONS } from "@/lib/timeRange";
import { pickBaseline, baselineLabel } from "@/lib/baseline";
import { type ClassificationEvent } from "@/hooks/useClassificationChangelog";
import { useHeadlineTiles } from "@/hooks/useHeadlineTiles";
import { ChainStatusBar, CompactProvenance } from "@/components/ChainStatusBar";
import { InfoTooltip } from "@/components/InfoTooltip";
import { InfoTip } from "@/components/InfoTip";
import { MethodologyInfo } from "@/components/MethodologyInfo";
import { StatTile } from "@/components/ui/stat-tile";
import { BarChart, Bar, ComposedChart, XAxis, YAxis, CartesianGrid, ReferenceLine, Line } from "recharts";
import { chainViewOptions, type ChainView } from "@/lib/chainViews";
import { stakingSplitSub } from "@/lib/stakingSplit";
import { RETAIL_WALLETS_LABEL, retailWalletsInfo, uniqueWalletCount } from "@/lib/holderCounts";
import { StakingSupplyTie } from "@/components/StakingSupplyTie";
import "@/lib/rechartsMotion";
import { athHistoryNote, historyDays } from "@/lib/athNote";
import { CHART_HEIGHT_CLASS, CHART_TICK, CHART_LABEL_FONT_PX } from "@/lib/terminalLayout";

const formatCompactTokens = (n: number) => formatCompact(n, 2);

type DisplaySelection = ChainView;

type DisplayResult = {
  key: DisplaySelection;
  title: string;
  subtitle: string | null;
  metrics: HolderMetrics;
  previousMetrics: HolderMetrics | null;
  concentration: HolderLiteView["concentration"];
  balanceStats: HolderLiteView["balanceStats"];
  stakingStats: HolderLiteView["stakingStats"];
  stakingDistribution: HolderLiteView["stakingDistribution"];
  velocity: HolderLiteView["velocity"];
  /** Distinct wallets across chains (combined view only); metrics.holderCount is the per-chain sum. */
  uniqueWallets: number | null;
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

const percentOf = (value: number, total: number) => (total > 0 ? (value / total) * 100 : 0);

const formatSignedTokenAmount = (value: number) => {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatTokenAmount(Math.abs(value))}`;
};

const formatSignedInteger = (value: number) => {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatInteger(Math.abs(value))}`;
};

const formatHost = (raw?: string | null) => {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.host || raw;
  } catch (error) {
    return raw;
  }
};

const TILE_HOVER =
  "hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 hover:scale-105 origin-center will-change-transform transition-[transform,box-shadow,border-color] duration-300 ease-out";


const displayResults = (
  copy: UseProjectCopy,
  snapshot: HolderLiteSnapshot | null,
  selection: DisplaySelection,
): DisplayResult | null => {
  if (!snapshot) {
    return null;
  }

  const view = snapshot.views[selection];
  if (!view) return null;

  if (selection === "combined") {
    return {
      key: selection,
      title: "All Wallets",
      subtitle: copy.t("All wallets with >0 {ticker} across {chains}."),
      metrics: view.metrics,
      previousMetrics: view.previousMetrics ?? null,
      concentration: view.concentration,
      balanceStats: view.balanceStats,
      stakingStats: view.stakingStats,
      stakingDistribution: view.stakingDistribution,
      velocity: view.velocity,
      uniqueWallets: uniqueWalletCount(snapshot),
    };
  }

  return {
    key: selection,
    title: `${view.label} Wallets`,
    subtitle: `All wallets with >0 ${copy.ticker} on ${view.label}.`,
    metrics: view.metrics,
    previousMetrics: view.previousMetrics ?? null,
    concentration: view.concentration,
    balanceStats: view.balanceStats,
    stakingStats: view.stakingStats,
    stakingDistribution: view.stakingDistribution,
    velocity: view.velocity,
    uniqueWallets: null,
  };
};

type HistoricalPrevious = {
  holderCount: number | null;
  totalBalance: number | null;
  totalHeld: number | null;
  stakingBalance: number | null;
  stakingV3Balance?: number | null;
  stakingTotal?: number | null;
  referenceDate?: string | null;
};

type StatItem = {
  label: string;
  value: string;
  description: string;
  badge?: string;
  /** Qualifier for the badge, e.g. "Based on 5 days of data". */
  badgeNote?: string | null;
  previous: number | null;
  rawValue: number;
  icon: LucideIcon;
  formatter?: (v: number) => string;
  info: string;
  changelogEvents?: ClassificationEvent[];
};

const renderMetrics = (
  copy: UseProjectCopy,
  result: DisplayResult,
  totals: HolderLiteSnapshot["totals"],
  cex?: CexFlowSnapshot | null,
  selection?: DisplaySelection,
  historicalPrevious?: HistoricalPrevious | null,
  deltaLabel?: string,
  cexPreviousOverride?: number | null,
  holderCountIsAth?: boolean,
  holdersEvents?: ClassificationEvent[],
  cexEvents?: ClassificationEvent[],
  retailBalanceEvents?: ClassificationEvent[],
  holderAthNote?: string | null,
) => {
  const previousHolderCount = historicalPrevious
    ? historicalPrevious.holderCount
    : (result.previousMetrics?.holderCount ?? null);
  // Retail baseline, matching the Retail Held tile below. Reading the
  // retail+CEX `totalHeld` here would report the entire ~20B CEX book as a
  // change against a retail-only current value. Still read from one field so
  // this never drifts from HolderKpiHero's number.
  const previousRetailHeld = historicalPrevious
    ? historicalPrevious.totalBalance
    : (result.previousMetrics?.totalBalance ?? null);
  // Staked = legacy + v3 StakingModule, so compare against the combined
  // baseline; inside the unmeasured v3 window there is none (see lib/staking).
  const v3Stats = result.stakingStats?.v3;
  const previousStakingBalance = historicalPrevious
    ? v3Stats
      ? historicalPrevious.stakingTotal ?? null
      : historicalPrevious.stakingBalance
    : null;
  const stakedEvents =
    v3Stats && historicalPrevious?.referenceDate
      ? v3StakingGapEvents(historicalPrevious.referenceDate, historicalPrevious.stakingV3Balance, v3Stats.deployDate ?? undefined, copy.ticker)
      : [];

  // Exchange-held TEL, added into the "Total TEL Held" tile so it counts all
  // wallets (custody deposits are not sales).
  const cexHeld = selection === "combined" ? (cex?.overall?.currentBalance ?? 0) : 0;

  const items: StatItem[] = [
    {
      label: RETAIL_WALLETS_LABEL,
      value: formatInteger(result.metrics.holderCount),
      description: holderCountIsAth ? "All-time high" : copy.t("Wallets >0 {ticker}, excl. exchanges"),
      badge: holderCountIsAth ? "ATH" : undefined,
      badgeNote: holderCountIsAth ? holderAthNote : null,
      previous: previousHolderCount,
      rawValue: result.metrics.holderCount,
      icon: Users,
      info: retailWalletsInfo({ ticker: copy.ticker, chains: copy.chains, walletCount: result.metrics.holderCount, uniqueWallets: result.uniqueWallets }),
      changelogEvents: holdersEvents,
    },
    {
      label: "Retail Held",
      value: formatTokenAmount(result.metrics.totalBalance),
      description: selection === "combined" ? "Excl. exchanges, treasury & DEX" : "Wallets on this chain",
      previous: previousRetailHeld,
      rawValue: result.metrics.totalBalance,
      icon: Database,
      formatter: formatTokenAmount,
      info: copy.text("holders.retailHeld.info", "{ticker} held in ordinary wallets — everything except exchange custody, treasury and team wallets, escrow, bridges and DEX liquidity.\n\nShown separately from CEX Balance rather than blended into one total, because the two moving in opposite directions is the signal: {ticker} leaving exchanges for self-custody is accumulation, the reverse is supply moving toward the market. A combined figure stays flat through both.\n\nStaked {ticker} is already inside this figure (credited to each staker's wallet), not added on top."),
      changelogEvents: retailBalanceEvents,
    },
  ];

  if (selection === "combined" && result.stakingStats != null) {
    const stakedTotal = result.stakingStats.stakedTotal ?? 0;
    items.push({
      label: copy.t("Staked {ticker}"),
      value: formatTokenAmount(stakedTotal),
      description: v3Stats && result.stakingStats.legacy && result.stakingStats.legacy.stakedTotal > 0 && v3Stats.stakedTotal > 0
        ? `Legacy ${formatCompactTokens(result.stakingStats.legacy.stakedTotal)} / v3 ${formatCompactTokens(v3Stats.stakedTotal)} · ${formatPercentage(percentOf(stakedTotal, totals.totalSupply))} of supply`
        : `${formatPercentage(percentOf(stakedTotal, totals.totalSupply))} of total supply`,
      previous: stakedEvents.length ? stakedTotal : previousStakingBalance,
      rawValue: stakedTotal,
      icon: Layers,
      formatter: formatTokenAmount,
      changelogEvents: stakedEvents,
      info: copy.text("holders.staked.info", "{ticker} locked in staking, counted once per staker. It's a subset of Retail Held (already counted there), shown separately as a measure of long-term conviction. Staked {ticker} can't be sold until unstaked."),
    });
  }

  if (selection === "combined" && cex?.overall != null) {
    const currentBalance = cex.overall.currentBalance ?? 0;
    const previousBalance = cexPreviousOverride !== undefined
      ? cexPreviousOverride
      : (cex.overall.previousBalance ?? null);
    items.push({
      label: "CEX Balance",
      value: formatTokenAmount(currentBalance),
      description: `${formatPercentage(
        percentOf(currentBalance, totals.totalSupply),
      )} of total supply`,
      previous: previousBalance,
      rawValue: currentBalance,
      icon: Building2,
      formatter: formatTokenAmount,
      info: copy.text("holders.cex.info", "{ticker} sitting in known exchange wallets. An exchange hot wallet is one commingled pool that backs all of that exchange's customers' {ticker} balances — it's mostly customer funds held in custody, not the exchange's own.\n\nTrading on an exchange happens in its private off-chain ledger, so on-chain we can't see whether any of this has been sold, nor how many people hold it. A rising balance means more {ticker} positioned near the market; a falling balance means {ticker} leaving exchanges (often to self-custody or staking)."),
      changelogEvents: cexEvents,
    });
  }

  const colClass =
    items.length >= 4 ? "grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4"
    : items.length === 3 ? "grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-3"
    : "grid gap-3 sm:gap-4 grid-cols-2";

  return (
    <div className={colClass}>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.label}
            className={`premium-surface-card p-4 sm:p-8 flex flex-col items-center justify-center text-center ${TILE_HOVER}`}
          >
            <Icon className="h-6 w-6 sm:h-8 sm:w-8 text-primary mb-2 sm:mb-3" />
            <div className="flex items-center gap-1.5 mb-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">{item.label}</div>
              {item.info && <InfoTooltip text={item.info} />}
            </div>
            {/* stack value + delta on narrow tiles so the chip can't clip the number */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-3 mb-2 min-w-0 max-w-full">
              <div className="text-2xl sm:text-4xl font-bold text-primary">{item.value}</div>
              {/* CEX Balance: neither direction is inherently good or bad
                  (custody ≠ sale — see the tile's info tooltip), so this one
                  stays neutral rather than implying growth is bad news. */}
              <ChangeIndicator
                current={item.rawValue}
                previous={item.previous}
                size="md"
                formatter={item.formatter}
                tone={item.label === "CEX Balance" ? "neutral" : "auto"}
                changelogEvents={item.changelogEvents}
              />
            </div>
            <div className={`flex items-center justify-center gap-1 text-xs ${item.badge === "ATH" ? "text-brand font-semibold" : "text-muted-foreground"}`}>
              {item.description}
              {item.badgeNote && <InfoTip content={item.badgeNote} label={`All-time high: ${item.badgeNote}`} />}
            </div>
            {deltaLabel && item.previous !== null && (
              <div className="text-xs text-muted-foreground mt-1">vs {deltaLabel}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const renderConcentration = (
  copy: UseProjectCopy,
  result: DisplayResult,
  ctl: RangeCtl,
  rangeDays: number,
  historicalTop?: Record<string, number> | null,
  historicalSupply?: number | null,
  referenceDate?: string | null,
  changelogEvents?: ClassificationEvent[],
) => {
  const supply = result.metrics.retail.balance;
  // Baseline: history entry at the selected range start, via the same
  // pickBaseline-derived historicalDelta every other range/widget uses
  // (passed in unconditionally now, including 1D — see useHeadlineTiles).
  // result.concentration.previousTop is only a loading-state fallback: it's
  // "whatever tel-holders-previous.json held at the last pipeline run"
  // (could be a week old), not "N days ago" — showing it as a live 1D delta
  // silently mislabeled the window. When no history point survives the
  // drift tolerance (e.g. 1Y before the archive covers it), show no
  // comparison instead of the wrong window, matching renderMetrics.
  const isRangeAware = true;
  const useHistorical = historicalTop != null;
  const previousSupply = useHistorical
    ? (historicalSupply ?? 0)
    : (result.previousMetrics?.retail.balance ?? 0);
  const hasPrevious = useHistorical || Boolean(result.concentration.previousTop);
  const currentTop = (n: number) => result.concentration.top[String(n)] ?? 0;
  const previousTop = (n: number) =>
    useHistorical
      ? (historicalTop?.[String(n)] ?? 0)
      : (result.concentration.previousTop?.[String(n)] ?? 0);

  const items = [
    { label: "Top 10", value: currentTop(10), previousValue: hasPrevious ? previousTop(10) : null },
    { label: "Top 25", value: currentTop(25), previousValue: hasPrevious ? previousTop(25) : null },
    { label: "Top 50", value: currentTop(50), previousValue: hasPrevious ? previousTop(50) : null },
    { label: "Top 100", value: currentTop(100), previousValue: hasPrevious ? previousTop(100) : null },
  ];

  const extendedItems = [
    { label: "Top 250", value: currentTop(250), previousValue: hasPrevious ? previousTop(250) : null },
    { label: "Top 500", value: currentTop(500), previousValue: hasPrevious ? previousTop(500) : null },
    { label: "Top 1000", value: currentTop(1000), previousValue: hasPrevious ? previousTop(1000) : null },
  ];

  const allConcentrationItems = [...items, ...extendedItems];
  const concentrationChartData = allConcentrationItems.map((item) => ({
    label: item.label,
    value: item.value,
    percent: supply > 0 ? (item.value / supply) * 100 : 0,
  }));
  const concentrationY = computeYAxisFromRows(concentrationChartData, ["percent"], { kind: "bar" });
  const concentrationSizing = barSizing(concentrationChartData.length);
  const concentrationChartConfig = {
    percent: { label: "% of retail", color: "hsl(var(--primary))" },
  };

  // Smart-money signal: net change in the top-100 cohort's balance over the
  // selected window. Accumulating = whales adding; distributing while the
  // retail total over the same window — reader interprets.
  // Factual cohort movement: top-100 balance change and total retail change
  // over the same window. No interpretation — the reader draws conclusions.
  const cohortNow = currentTop(100);
  const cohortPrev = hasPrevious ? previousTop(100) : null;
  const cohortChange = cohortPrev !== null && cohortPrev > 0 ? cohortNow - cohortPrev : null;
  const retailChange = supply - previousSupply;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-lg font-semibold text-foreground">Concentration Spread</span>
        <MethodologyInfo section="concentration" />
        <span className="text-xs font-medium text-muted-foreground border border-border/60 rounded-full px-2 py-0.5">
          Retail only — excludes exchange &amp; hot wallets
        </span>
              </div>
      {isRangeAware && (
        <div className="text-xs text-muted-foreground">
          {hasPrevious ? `Compared vs ${baselineLabel(referenceDate)}` : "No baseline available for this period."}
        </div>
      )}
      {cohortChange !== null && (
        <div className="rounded-2xl border border-border/50 bg-muted/20 px-5 py-4 text-center">
          <div className="text-xl font-bold text-foreground">
            Top 100 holders: {cohortChange >= 0 ? "+" : "−"}{formatTokenAmount(Math.abs(cohortChange))} {copy.ticker}
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            Total retail holdings: {retailChange >= 0 ? "+" : "−"}{formatTokenAmount(Math.abs(retailChange))} over the same period
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
        {[...items, ...extendedItems].map((item) => {
          const pct = supply > 0 ? (item.value / supply) * 100 : 0;
          const previousPct = previousSupply > 0 && item.previousValue !== null && item.previousValue !== undefined
            ? (item.previousValue / previousSupply) * 100
            : null;
          return (
            <div key={item.label} className={`premium-surface-card p-4 sm:p-6 flex flex-col items-center justify-center text-center ${TILE_HOVER}`}>
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-3">{item.label}</div>
              <div className="flex items-center gap-2 mb-2 flex-wrap justify-center">
                <div className="text-xl sm:text-3xl font-bold text-primary">{formatTokenAmount(item.value)}</div>
                {/* The TEL amount held — real gain/loss, colored red/green */}
                <ChangeIndicator
                  current={item.value}
                  previous={item.previousValue ?? null}
                  formatter={formatTokenAmount}
                  changelogEvents={changelogEvents}
                />
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap justify-center">
                {formatPercentage(pct, 2)} of retail
                {/* Share of the pool, NOT gain/loss — a shrinking share can
                    still mean this cohort holds more TEL (smaller wallets
                    just grew faster). Showing the plain "was X%" instead of
                    a "pp" (percentage-point) delta, since that abbreviation
                    isn't something most readers would recognize. */}
                {previousPct !== null && previousPct !== undefined && (
                  <span className="text-muted-foreground">(was {previousPct.toFixed(2)}%)</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {concentrationChartData.some((d) => d.percent > 0) && (
        <div className="premium-surface-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-3 text-center">Top holders share of retail (% by tier)</p>
          <ChartContainer config={concentrationChartConfig} className={`${CHART_HEIGHT_CLASS.standard} w-full`}>
            <BarChart data={concentrationChartData} margin={{ top: 12, right: 12, bottom: 24, left: 12 }} barCategoryGap={concentrationSizing.barCategoryGap}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis dataKey="label" tick={CHART_TICK} />
              <YAxis tick={CHART_TICK} tickFormatter={(v) => `${v}%`} domain={concentrationY.domain} ticks={concentrationY.ticks} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="percent" fill="hsl(var(--primary) / 0.8)" radius={[4, 4, 0, 0]} maxBarSize={concentrationSizing.maxBarSize} minPointSize={concentrationSizing.minPointSize} />
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </div>
  );
};

type HolderMomentum = {
  net: number;
  perDay: number;
  pct: number;
  current: number;
  baseline: number;
  days: number;
};

const renderVelocity = (
  copy: UseProjectCopy,
  momentum: HolderMomentum | null,
  selectionLabel: string,
  rangeLabel: string,
  ctl: RangeCtl,
  everHeld?: { newInRange: number | null; total: number | null } | null,
) => {
  if (!momentum) return null;

  const netTone = momentum.net >= 0 ? "text-positive" : "text-negative";
  const positiveTone = "text-positive";
  const ticker = copy.t("{ticker}");
  const items: Array<{ label: string; value: string; sub: string; tone: string; info: string }> = [];
  if (everHeld?.total != null) {
    // Adoption framing first: first-time holders never subtract churn.
    items.push({
      label: `New Wallets (${rangeLabel})`,
      value: everHeld.newInRange != null ? `+${formatInteger(everHeld.newInRange)}` : "—",
      sub: "first-time wallets",
      tone: positiveTone,
      info: copy.t(`Wallets that held {ticker} for the first time in ${rangeLabel}. Wallets that sell or leave never reduce this number.`),
    });
    items.push({
      label: copy.t("Wallets Ever Held {ticker}"),
      value: formatInteger(everHeld.total),
      sub: "cumulative — only grows",
      tone: "text-primary",
      info: copy.t("Every wallet that has ever held {ticker} on the tracked chains. This total only grows."),
    });
    items.push({
      label: `Net Active Wallets (${rangeLabel})`,
      value: formatSignedInteger(momentum.net),
      sub: `${momentum.pct >= 0 ? "+" : ""}${momentum.pct.toFixed(2)}% active base`,
      tone: netTone,
      info: `Wallets gained minus wallets lost in ${rangeLabel}, with the percentage relative to the active base at the start. Negative means more ${ticker} wallets left than joined.`,
    });
  } else {
    items.push({
      label: `Net New Wallets (${rangeLabel})`,
      value: formatSignedInteger(momentum.net),
      sub: `${formatSignedInteger(Math.round(momentum.perDay))} / day`,
      tone: netTone,
      info: `Wallets holding ${ticker} at the end of ${rangeLabel} minus at the start. Negative means more wallets left than joined. The per-day figure is the same change averaged over the days.`,
    });
    items.push({
      label: "Growth",
      value: `${momentum.pct >= 0 ? "+" : ""}${momentum.pct.toFixed(2)}%`,
      sub: `over ${Math.round(momentum.days)} days`,
      tone: netTone,
      info: `Percentage change in the ${ticker} wallet count from the start of the range to the end.`,
    });
    items.push({
      label: "Total Retail Wallets",
      value: formatInteger(momentum.current),
      sub: `from ${formatInteger(momentum.baseline)}`,
      tone: "text-primary",
      info: copy.t("Wallets holding {ticker} outside exchange and hot wallets now, with the count at the start of the range."),
    });
  }

  return (
    <Card className="premium-surface-card">
      <CardHeader className="px-4 py-4 sm:px-6 sm:py-5 border-b border-border/60 bg-muted/40">
        <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-foreground flex items-center gap-1.5 sm:gap-2">
          <Activity className="h-5 w-5 text-primary shrink-0" />
          <span className="min-w-0">Holder Momentum</span>
          <MethodologyInfo section="holderMomentum" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-3 pt-5 sm:px-6">
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          {items.map((item) => (
            <StatTile
              key={item.label}
              label={item.label}
              value={item.value}
              sub={item.sub}
              valueClassName={item.tone}
              info={item.info}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

const balanceInsightsChartConfig = {
  count: { label: "Wallets", color: "hsl(var(--primary))" },
};

// Fit a log-normal curve over the bucket midpoints and scale it to match bar heights.
// Returns a smoothed count value for each bucket index.
const fitLogNormalCurve = (buckets: { count: number }[], logMidpoints: number[]): number[] => {
  if (buckets.length === 0) return [];
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) return buckets.map(() => 0);

  // Use median bucket index as the peak to find log-mean
  const logMean = logMidpoints[Math.round(logMidpoints.length / 2) - 1] ?? logMidpoints[0];
  const logStd = 2.1; // typical for token distributions

  const raw = logMidpoints.map((lx) => {
    const z = (lx - logMean) / logStd;
    return Math.exp(-0.5 * z * z);
  });
  const rawSum = raw.reduce((s, v) => s + v, 0);
  // Scale so the curve integrates to approximately total holders
  return raw.map((v) => Math.round((v / rawSum) * total * 1.05));
};

// Approximate log-midpoint for each of TEL's range labels (kept verbatim so
// TEL's curve is unchanged). Other projects' `holders.balanceRanges` get the
// geometric midpoint of [min, max) (open top bucket: min·√10) — logMidFor.
const BUCKET_LOG_MIDS: Record<string, number> = {
  "1–100": Math.log(10),
  "100–1K": Math.log(316),
  "1K–10K": Math.log(3162),
  "10K–100K": Math.log(31623),
  "100K–1M": Math.log(316228),
  "1M–10M": Math.log(3162278),
  "10M+": Math.log(31622776),
};

const logMidFor = (label: string, ranges: readonly TierRange[]): number => {
  if (label in BUCKET_LOG_MIDS) return BUCKET_LOG_MIDS[label]!;
  const r = ranges.find((x) => x.label === label);
  if (!r) return 0;
  const lo = Math.max(r.min, 1);
  const hi = Number.isFinite(r.max) ? r.max : lo * 10;
  return (Math.log(lo) + Math.log(hi)) / 2;
};

// Display-only override, currently a no-op: BALANCE_RANGES' bottom bucket
// ("1–100") floors at 1 TEL (scripts/lib/holdersView.js — sub-1-TEL dust
// wallets are deliberately excluded from every bucket, see lessons.md
// "Sub-1-TEL Dust Wallets Are Deliberately Excluded From Buckets, Not
// Counts"), so the raw label is accurate as written. Kept as a formatter
// hook (wired into the XAxis/tooltip below) in case the floor changes again
// — do not reintroduce a "1–100" override without checking the floor first.
const balanceRangeDisplayLabel = (label: string): string => label;

/** The timeframe control itself lives once in the page's sticky bar; each
 *  section just confirms which period its numbers reflect. */
type RangeCtl = { rangeDays: number; onRangeDaysChange: (d: number) => void };

const renderBalanceInsights = (copy: UseProjectCopy, stats: HolderLiteView["balanceStats"] | null, ctl: RangeCtl) => {
  if (!stats || stats.count === 0) return null;

  // Gini is a raw statistics term with no obvious meaning to most readers —
  // give it a plain-language descriptor alongside the number so it doesn't
  // require knowing what "Gini coefficient" means to get the point.
  const giniDescriptor =
    stats.gini >= 0.85 ? "Highly concentrated" : stats.gini >= 0.6 ? "Concentrated" : stats.gini >= 0.4 ? "Moderately spread" : "Broadly spread";

  const items = [
    { label: "Average Balance", value: formatTokenAmount(stats.average), sub: null as string | null, info: null as string | null },
    { label: "Median Balance", value: formatTokenAmount(stats.median), sub: null, info: null },
    { label: "P90 Balance", value: formatTokenAmount(stats.p90), sub: null, info: null },
    { label: "P99 Balance", value: formatTokenAmount(stats.p99), sub: null, info: null },
    {
      label: "Gini Coefficient", value: stats.gini.toFixed(3), sub: giniDescriptor,
      info: copy.t("A standard measure of how unevenly {ticker} is spread across retail wallets. 0 would mean every wallet holds the same amount; 1 would mean a single wallet holds it all. Most tokens land well above 0.9, since a small number of long-term holders naturally accumulate more than a large number of small wallets."),
    },
  ];

  // Option A: bar + log-normal curve overlay
  const logMids = stats.distributionBuckets.map((b) => logMidFor(b.rangeLabel, copy.tiers.balanceRanges));
  const curveValues = fitLogNormalCurve(stats.distributionBuckets, logMids);
  const chartData = stats.distributionBuckets.map((b, i) => ({
    range: b.rangeLabel,
    count: b.count,
    curve: curveValues[i],
  }));
  const fitSizing = barSizing(chartData.length);

  // Option B: percentile ruler data
  const percentiles = [
    { label: "p50 (median)", value: stats.median ?? stats.p50, pct: 50, color: "hsl(var(--primary))" },
    { label: "p75", value: stats.p75, pct: 75, color: "hsl(188 95% 55%)" },
    { label: "p90", value: stats.p90, pct: 90, color: "hsl(152 71% 45%)" },
    { label: "p99", value: stats.p99, pct: 99, color: "hsl(262 83% 65%)" },
  ].filter((p) => p.value != null && p.value > 0);

  const logMax = Math.log10(stats.p99 * 3);

  return (
    <Card className="premium-surface-card">
      <CardHeader className="px-4 py-4 sm:px-6 sm:py-5 border-b border-border/60 bg-muted/40">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Balance Insights
            <MethodologyInfo section="balanceInsights" />
          </CardTitle>
        </div>
        <CardDescription data-panel-desc className="text-sm sm:text-base text-muted-foreground">
          Distribution stats and balance curve for retail wallets (&gt;0 {copy.ticker}, excludes exchange &amp; hot wallets).
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-5 space-y-6">
        {/* Stat tiles */}
        <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-5">
          {items.map((item) => (
            <div key={item.label} className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-lg:last:odd:col-span-2 ${TILE_HOVER}`}>
              <div className="flex items-center justify-center gap-1 mb-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">{item.label}</div>
                {item.info && <InfoTooltip text={item.info} />}
              </div>
              <div className="text-xl font-semibold text-primary">{item.value}</div>
              {item.sub && <div className="text-xs text-muted-foreground mt-1 lg:basis-full">{item.sub}</div>}
            </div>
          ))}
        </div>

        {/* Option B: Percentile ruler */}
        {percentiles.length > 0 && (
          <div className="premium-surface-card p-4 space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-4 text-center">Percentile ruler — where holders rank by balance</p>
            {percentiles.map((p) => {
              const logVal = Math.log10(Math.max(1, p.value));
              const widthPct = Math.min(100, Math.round((logVal / logMax) * 100));
              return (
                // Below sm the labels sit ABOVE the bar. Side by side they
                // budget 300px of non-shrinking chrome (w-28 + w-24 + w-14 +
                // three gap-3), which inside a ~366px card left the bar about
                // 66px wide — the one thing the row exists to show.
                <div key={p.label} className="text-xs sm:flex sm:items-center sm:gap-3">
                  <div className="flex items-baseline justify-between gap-2 pb-1 sm:hidden">
                    <span className="text-muted-foreground">{p.label}</span>
                    <span className="font-semibold text-foreground tabular-nums">
                      {formatTokenAmount(p.value)} {copy.ticker} · {p.pct}th %
                    </span>
                  </div>
                  <span className="hidden sm:block w-28 shrink-0 text-right text-muted-foreground whitespace-nowrap">{p.label}</span>
                  <div className="flex-1 h-6 rounded bg-muted/30 relative overflow-hidden min-w-0">
                    <div
                      className="absolute left-0 top-0 h-full rounded"
                      style={{ width: `${widthPct}%`, background: p.color, opacity: 0.75 }}
                    />
                  </div>
                  <span className="hidden sm:block w-24 shrink-0 text-right font-semibold text-foreground tabular-nums whitespace-nowrap">
                    {formatTokenAmount(p.value)} {copy.ticker}
                  </span>
                  <span className="hidden sm:block w-14 shrink-0 text-muted-foreground whitespace-nowrap">{p.pct}th %</span>
                </div>
              );
            })}
            {stats.average != null && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                Average: <span className="text-foreground font-medium">{formatTokenAmount(stats.average)} {copy.ticker}</span>
                {" "}· the typical (median) wallet holds just {stats.average > 0 ? ((stats.median / stats.average) * 100).toFixed(0) : "—"}% of that — a few large holders pull the average up
              </p>
            )}
          </div>
        )}

        {/* Option A: Bar + log-normal curve overlay */}
        {chartData.some((d) => d.count > 0) && (
          <div className="premium-surface-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1 text-center">Balance distribution — holder count by range</p>
            <p data-panel-desc className="text-xs text-muted-foreground mb-3 text-center">
              Balance buckets are log-spaced; the count axis is linear. The curve is a log-normal fit.
              Buckets exclude sub-1-{copy.ticker} dust wallets, so bars sum to slightly fewer holders than the tiles above.
            </p>
            <ToggleableSeries items={FIT_LEGEND} className="mb-2 justify-center">
              {(isVisible) => {
                // Fitted to whichever of bars / curve is switched on.
                const fitY = computeYAxisFromRows(chartData, ["count", "curve"].filter((k) => isVisible(k)), { kind: "bar", integer: true });
                return (
            <ChartContainer
              config={{
                count: { label: "Wallets", color: "hsl(var(--primary))" },
                curve: { label: "Log-normal fit", color: "hsl(188 95% 55%)" },
              }}
              className={`${CHART_HEIGHT_CLASS.standard} w-full`}
            >
              <ComposedChart data={chartData} margin={{ top: 20, right: 24, bottom: 36, left: 24 }} barCategoryGap={fitSizing.barCategoryGap}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis dataKey="range" tickFormatter={balanceRangeDisplayLabel} tick={CHART_TICK} height={36} />
                <YAxis tick={CHART_TICK} domain={fitY.domain} ticks={fitY.ticks} allowDataOverflow={false} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(value) => balanceRangeDisplayLabel(String(value))} />} />
                {isVisible("count") && <Bar dataKey="count" fill="hsl(var(--primary) / 0.35)" stroke="hsl(var(--primary))" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={fitSizing.maxBarSize} minPointSize={fitSizing.minPointSize} />}
                {isVisible("curve") && <Line
                  dataKey="curve"
                  type="monotone"
                  stroke="hsl(188 95% 55%)"
                  strokeWidth={2.5}
                  dot={false}
                  strokeDasharray="0"
                />}
                {stats.averageRangeLabel && chartData.some((d) => d.range === stats.averageRangeLabel) && (
                  <ReferenceLine
                    x={stats.averageRangeLabel}
                    stroke="hsl(var(--destructive))"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    label={{ value: "Avg", position: "top", fill: "hsl(var(--destructive))", fontSize: CHART_LABEL_FONT_PX }}
                  />
                )}
              </ComposedChart>
            </ChartContainer>
                );
              }}
            </ToggleableSeries>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const FIT_LEGEND: LegendItem[] = [
  { key: "count", label: "Wallets", color: "hsl(var(--primary))" },
  { key: "curve", label: "Log-normal fit", color: "hsl(188 95% 55%)" },
];

const stakingInsightsChartConfig = {
  count: { label: "Stakers", color: "hsl(var(--primary))" },
};

const renderStakingInsights = (
  copy: UseProjectCopy,
  stats: HolderLiteView["stakingStats"] | null,
  distribution: HolderLiteView["stakingDistribution"] | null,
  ctl: RangeCtl,
) => {
  if (!stats || stats.holderCount === 0) return null;

  // "Staked Share" and "Staker Share" were a near-identical pair of labels
  // for two different things (% of TEL staked vs. % of wallets that stake) —
  // easy to mix up at a glance. Named for what each one actually counts.
  const items = [
    {
      label: "Stakers",
      value: formatInteger(stats.stakerCount),
      sub: stakingSplitSub(stats, "count", formatInteger),
    },
    {
      label: "Staked Total",
      value: formatTokenAmount(stats.stakedTotal),
      sub: stakingSplitSub(stats, "total", formatCompactTokens),
    },
    { label: copy.t("% of Retail {ticker} Staked"), value: formatPercentage(stats.stakedShareOfRetail * 100, 2) },
    { label: "% of Wallets Staking", value: formatPercentage(stats.stakerShareOfHolders * 100, 2) },
    { label: "Avg Staked", value: formatTokenAmount(stats.averageStakedPerStaker) },
  ];

  const chartData = distribution?.distributionBuckets.map((b) => ({
    range: b.rangeLabel,
    count: b.count,
  })) ?? [];
  const stakedY = computeYAxisFromRows(chartData, ["count"], { kind: "bar", integer: true });
  const stakedSizing = barSizing(chartData.length);

  return (
    <Card className="premium-surface-card">
      <CardHeader className="px-4 py-4 sm:px-6 sm:py-5 border-b border-border/60 bg-muted/40">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Banknote className="h-5 w-5 text-primary" />
            Staking Overview
            <MethodologyInfo section="staking" />
          </CardTitle>
        </div>
        {copy.hasText("staking.addresses.note") ? null : (
          <CardDescription data-panel-desc className="text-sm sm:text-base text-muted-foreground">
            {copy.text("staking.intro", "{ticker} staked by retail, mapped back to holder wallets and counted once per staker (excludes exchange & hot wallets).")}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="pt-5 space-y-6">
        <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-5">
          {items.map((item) => (
            <div key={item.label} className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-lg:last:odd:col-span-2 ${TILE_HOVER}`}>
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">{item.label}</div>
              <div className="text-xl font-semibold text-primary">{item.value}</div>
              {"sub" in item && item.sub && <div className="mt-1 text-xs tabular-nums text-muted-foreground lg:basis-full">{item.sub}</div>}
            </div>
          ))}
        </div>
        <StakingSupplyTie />
        {chartData.some((d) => d.count > 0) && (
          <div className="premium-surface-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1 text-center">Staked balance distribution (staker count by range)</p>
            <p className="text-xs text-muted-foreground mb-3 text-center">Buckets exclude sub-1-{copy.ticker} dust amounts, so bars sum to slightly fewer stakers than the tiles above.</p>
            <ChartContainer config={stakingInsightsChartConfig} className={`${CHART_HEIGHT_CLASS.standard} w-full`}>
              <BarChart
                data={chartData}
                margin={{ top: 20, right: 24, bottom: 36, left: 24 }}
                barCategoryGap={stakedSizing.barCategoryGap}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis dataKey="range" tickFormatter={balanceRangeDisplayLabel} tick={CHART_TICK} height={36} />
                <YAxis
                  tick={CHART_TICK}
                  domain={stakedY.domain}
                  ticks={stakedY.ticks}
                  allowDataOverflow={false}
                />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(value) => balanceRangeDisplayLabel(String(value))} />} />
                <Bar dataKey="count" fill="hsl(var(--primary) / 0.35)" stroke="hsl(var(--primary))" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={stakedSizing.maxBarSize} minPointSize={stakedSizing.minPointSize} />
                {distribution?.averageStakedRangeLabel && chartData.some((d) => d.range === distribution.averageStakedRangeLabel) && (
                  <ReferenceLine
                    x={distribution.averageStakedRangeLabel}
                    stroke="hsl(var(--destructive))"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    label={{ value: "Avg staked", position: "top", fill: "hsl(var(--destructive))", fontSize: 12 }}
                  />
                )}
              </BarChart>
            </ChartContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const renderOverlap = (stats: HolderLiteSnapshot["overlap"] | null, ctl: RangeCtl) => {
  if (!stats) return null;

  return (
    <Card className="premium-surface-card">
      <CardHeader className="px-4 py-4 sm:px-6 sm:py-5 border-b border-border/60 bg-muted/40">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            Multi-chain Overlap
            <MethodologyInfo section="overlap" />
          </CardTitle>
        </div>
        <CardDescription className="text-sm sm:text-base text-muted-foreground">
          Unique wallets across chains in the combined view (a wallet on several chains counts once).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <div className="grid gap-3 sm:gap-4 grid-cols-2 sm:grid-cols-3">
          <div className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-sm:last:odd:col-span-2 ${TILE_HOVER}`}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">Unique Wallets</div>
            <div className="text-xl font-semibold text-primary">{formatInteger(stats.uniqueCount)}</div>
          </div>
          <div className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-sm:last:odd:col-span-2 ${TILE_HOVER}`}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">Multi-chain Wallets</div>
            <div className="text-xl font-semibold text-primary">{formatInteger(stats.multiChainCount)}</div>
          </div>
          <div className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-sm:last:odd:col-span-2 ${TILE_HOVER}`}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">Multi-chain Share</div>
            <div className="text-xl font-semibold text-primary">{formatPercentage(stats.multiChainShare * 100, 2)}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          {stats.chainKeys.map((key) => (
            <Badge key={key} variant="outline">
              {key.charAt(0).toUpperCase() + key.slice(1)}: {formatInteger(stats.chainCounts[key] ?? 0)}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

const ETHERSCAN_ADDRESS = "https://etherscan.io/address/";

const renderCexFlows = (
  copy: UseProjectCopy,
  cex: CexFlowSnapshot | null | undefined,
  selection: DisplaySelection,
  expandedExchange: string | null,
  onToggleExpand: (name: string) => void,
  rangeDays: number,
  onRangeDaysChange: (days: number) => void,
  cexHistory?: CexHistoryEntry[],
) => {
  if (selection !== "combined" || !cex?.overall) return null;

  const overall = cex.overall;

  // Range-aware baseline from the per-exchange balance history: the entry
  // closest to (latest - rangeDays). Falls back to snapshot-over-snapshot
  // values when no history is available.
  // A gap in the archive shouldn't silently relabel a far-off point as
  // "vs {rangeLabel}" — fall back to the snapshot-over-snapshot values
  // (the existing !rangeStart branch below) instead.
  const rangeStart = cexHistory
    ? pickBaseline(cexHistory, rangeDays, (e) => Date.parse(e.date))
    : null;

  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`;
  const exchangeNet = (name: string, fallback: number) =>
    rangeStart ? (cexHistory![cexHistory!.length - 1].exchanges[name] ?? 0) - (rangeStart.exchanges[name] ?? 0) : fallback;
  const overallRange = (() => {
    if (!rangeStart) {
      return { previousBalance: overall.previousBalance, inflow: overall.inflow, outflow: overall.outflow, net: overall.net };
    }
    const latest = cexHistory![cexHistory!.length - 1];
    let inflow = 0, outflow = 0;
    const names = new Set([...Object.keys(latest.exchanges), ...Object.keys(rangeStart.exchanges)]);
    for (const n of names) {
      const d = (latest.exchanges[n] ?? 0) - (rangeStart.exchanges[n] ?? 0);
      if (d > 0) inflow += d; else outflow += -d;
    }
    return { previousBalance: rangeStart.total, inflow, outflow, net: latest.total - rangeStart.total };
  })();
  const updatedAt = cex.listUpdatedAt
    ? new Date(cex.listUpdatedAt).toLocaleString()
    : null;
  const exchanges: CexExchangeTotals[] = Array.isArray(cex.exchanges) ? cex.exchanges : [];

  const getWalletsForExchange = (exchange: CexExchangeTotals): CexExchangeWallet[] => {
    const withBalanceOnly = (list: CexExchangeWallet[]) =>
      list.filter((w) => (w.currentBalance ?? 0) > 0);
    if (Array.isArray(exchange.wallets) && exchange.wallets.length > 0) {
      return withBalanceOnly(exchange.wallets);
    }
    return [];
  };

  return (
    <Card className="premium-surface-card">
      <CardHeader className="px-4 py-4 sm:px-6 sm:py-5 border-b border-border/60 bg-muted/40">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              CEX Flow Snapshot
              <MethodologyInfo section="cexFlows" />
            </CardTitle>
            <CardDescription className="text-sm sm:text-base text-muted-foreground">
              Net changes for centralized exchange wallets. Click an exchange to see wallet addresses.
            </CardDescription>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {updatedAt && <Badge variant="outline">List updated {updatedAt}</Badge>}
              {cex.listQueryId && <Badge variant="outline">Query {cex.listQueryId}</Badge>}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <div className="grid gap-3 sm:gap-4 grid-cols-2 sm:grid-cols-3">
          <div className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-sm:last:odd:col-span-2 ${TILE_HOVER}`}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">Exchange Wallets</div>
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              <div className="text-2xl font-semibold text-primary">{formatInteger(overall.walletCountWithBalance)}</div>
              {/* only show the chip when it actually changed — a "0" is noise here */}
              <ChangeIndicator
                current={overall.walletCountWithBalance}
                previous={
                  overall.previousWalletCountWithBalance != null &&
                  overall.previousWalletCountWithBalance !== overall.walletCountWithBalance
                    ? overall.previousWalletCountWithBalance
                    : null
                }
              />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">holding {copy.ticker}, of {formatInteger(overall.walletCount)} tracked</div>
          </div>
          <div className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-sm:last:odd:col-span-2 ${TILE_HOVER}`}>
            <div className="flex items-center justify-center gap-1.5 mb-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">CEX Balance</div>
              <InfoTooltip text={copy.text("cex.balance.info", "{ticker} held in known exchange wallets. Additional balances may exist in untagged wallets, so treat this as a floor, not a total.")} />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              <div className="text-2xl font-semibold text-primary">{formatTokenAmount(overall.currentBalance)}</div>
              {/* Neutral — neither direction is inherently good or bad here
                  (custody ≠ sale). */}
              <ChangeIndicator
                current={overall.currentBalance}
                previous={overallRange.previousBalance}
                mode="percentage"
                precision={2}
                tone="neutral"
              />
            </div>
          </div>
          <div className={`premium-surface-card p-3 sm:p-5 text-center min-w-0 lg:flex-wrap max-sm:last:odd:col-span-2 ${TILE_HOVER}`}>
            <div className="flex items-center justify-center gap-1.5 mb-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Balance Change ({rangeLabel})</div>
              <InfoTooltip text={copy.t("How much the tracked exchange balances moved over this window — a change in STOCK, not measured flow.\n\nIt also shifts when an exchange reshuffles {ticker} between tagged and untagged wallets, so it won't exactly equal deposits minus withdrawals.\n\nFor measured FLOW — actual deposits and withdrawals counted from on-chain Transfer logs — see Exchange Netflow below.")} />
            </div>
            <div className="text-2xl font-semibold text-primary">{formatSignedTokenAmount(overallRange.net)}</div>
            <div className="text-xs text-muted-foreground">Gained {formatTokenAmount(overallRange.inflow)} • Declined {formatTokenAmount(overallRange.outflow)}</div>
          </div>
        </div>

        {exchanges.length > 0 && (
          <div className="overflow-x-auto -webkit-overflow-scrolling-touch rounded-2xl border border-border/50">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="text-left font-semibold text-muted-foreground text-xs sm:text-sm px-1 sm:px-4 w-6 sm:w-10" aria-label="Expand" />
                  <TableHead className="text-left font-semibold text-muted-foreground text-xs sm:text-sm px-1 sm:px-4">Exchange</TableHead>
                  {/* Wallets is the lowest-priority column and the reason
                      Net(range) — the number this section exists for — sat
                      off-screen at 430px. Hidden below sm; the count is still
                      recoverable by expanding the row, which lists each wallet.
                      Same treatment as DistributionAnalysisWidget's pp chip. */}
                  <TableHead className="hidden sm:table-cell text-right font-semibold text-muted-foreground text-xs sm:text-sm px-2 sm:px-4">Wallets</TableHead>
                  <TableHead className="text-right font-semibold text-muted-foreground text-xs sm:text-sm px-1 sm:px-4">Balance</TableHead>
                  <TableHead title={`Net (${rangeLabel})`} className="text-right font-semibold text-muted-foreground text-xs sm:text-sm px-1 sm:px-4 whitespace-nowrap">Net<span className="max-sm:hidden"> ({rangeLabel})</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exchanges.map((exchange) => {
                  const displayWallets = getWalletsForExchange(exchange);
                  const hasWallets =
                    displayWallets.length > 0 ||
                    (exchange.walletCountWithBalance ?? 0) >= 1;
                  const isExpanded = expandedExchange === exchange.name;
                  const handleToggle = () => hasWallets && onToggleExpand(exchange.name);
                  return (
                    <Fragment key={exchange.name}>
                      <TableRow
                        role="button"
                        tabIndex={0}
                        className="hover:bg-muted/20 transition-colors cursor-pointer"
                        onClick={handleToggle}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleToggle();
                          }
                        }}
                      >
                        <TableCell className="px-1 sm:px-4 py-2 w-6 sm:w-10">
                          {hasWallets ? (
                            isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )
                          ) : null}
                        </TableCell>
                        <TableCell className="px-1 sm:px-4 py-2 max-sm:text-xs text-sm font-medium text-foreground max-sm:max-w-[5.5rem] max-sm:truncate">{exchange.name}</TableCell>
                        <TableCell className="hidden sm:table-cell px-2 sm:px-4 py-2 text-right text-sm text-muted-foreground">{formatInteger(exchange.walletCountWithBalance)}</TableCell>
                        <TableCell className="px-1 sm:px-4 py-2 max-sm:text-xs text-right text-sm text-muted-foreground whitespace-nowrap">{formatTokenAmount(exchange.currentBalance)}</TableCell>
                        {(() => {
                          const net = exchangeNet(exchange.name, exchange.net);
                          // Match Exchange Netflow's convention below: MORE on
                          // an exchange (net > 0) reads as potential sell
                          // pressure (red), LESS (net < 0, leaving for
                          // self-custody) reads as bullish (green) — the
                          // opposite of a naive "balance went up = green".
                          // Using the same polarity in both places avoids
                          // showing two different colors for the same idea
                          // on one page.
                          return (
                            <TableCell
                              className={`px-1 sm:px-4 py-2 max-sm:text-xs text-right text-sm font-medium tabular-nums whitespace-nowrap ${
                                net > 0 ? "text-negative" : net < 0 ? "text-positive" : "text-muted-foreground"
                              }`}
                            >
                              {formatSignedTokenAmount(net)}
                            </TableCell>
                          );
                        })()}
                      </TableRow>
                      {hasWallets && isExpanded && (
                        <TableRow key={`${exchange.name}-wallets`} className="bg-muted/10 hover:bg-muted/10">
                          <TableCell colSpan={5} className="px-2 sm:px-4 py-3">
                            <div className="pl-6 overflow-x-auto">
                              {displayWallets.length === 0 ? (
                                <p className="text-sm text-muted-foreground py-2">Wallet details loading…</p>
                              ) : (
                              <Table>
                                <TableHeader>
                                  <TableRow className="border-0 hover:bg-transparent">
                                    <TableHead className="text-left font-semibold text-muted-foreground text-xs px-2 py-1">Wallet</TableHead>
                                    <TableHead className="text-right font-semibold text-muted-foreground text-xs px-2 py-1">{copy.ticker}</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {displayWallets.map((w) => (
                                    <TableRow key={w.address} className="border-0 hover:bg-muted/20">
                                      <TableCell className="px-2 py-1.5 text-sm">
                                        <a
                                          href={`${ETHERSCAN_ADDRESS}${w.address}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-primary hover:underline font-mono"
                                        >
                                          {w.walletName ?? `${w.address.slice(0, 6)}...${w.address.slice(-4)}`}
                                        </a>
                                        {/* When a name is shown, the address is otherwise hidden —
                                            two wallets can share the same label (e.g. two "KuCoin 49"),
                                            so always surface the address to tell rows apart. */}
                                        {w.walletName && (
                                          <div className="text-xs text-muted-foreground font-mono">
                                            {`${w.address.slice(0, 6)}...${w.address.slice(-4)}`}
                                          </div>
                                        )}
                                      </TableCell>
                                      <TableCell className="px-2 py-1.5 text-right text-sm text-muted-foreground">
                                        {formatTokenAmount(w.currentBalance)}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* ExchangeNetflow moved out to its own top-level "Exchange Flows"
            section on /holders — it is the one series reclassification cannot
            move, and it was buried below this table. See ExchangeFlowWidget.

            CexHistoryTiles used to render here too; it is now a sibling inside
            the Exchanges sub-panel so the two blocks are peers rather than one
            nested in the other's card. */}
      </CardContent>
    </Card>
  );
};

type WalletHoldingsWidgetProps = {
  selectedView: DisplaySelection;
  onViewChange: (view: DisplaySelection) => void;
  rangeDays: number;
  onRangeDaysChange: (days: number) => void;
  /** Rendered as the "Trends" panel — the historical charts that used to be a
   *  separate card on the Overview tab. Passed in as a slot rather than
   *  imported here so Holders.tsx keeps owning those widgets and their props;
   *  this component only supplies the panel to put them in. */
  trendsPanel?: ReactNode;
  /** Rendered as the "Flows" panel — measured exchange netflow. */
  flowsPanel?: ReactNode;
  /** Optional controlled sub-panel. Supplied when something outside this card
   *  needs to open a specific panel — the headline tiles do exactly that, so a
   *  reader reaches the charts in one click instead of tab-then-sub-tab.
   *  Uncontrolled (internal state) when omitted. */
  panel?: string;
  onPanelChange?: (panel: string) => void;
  /** Drops the card's title/description block. Set when the reader arrived by
   *  clicking a headline tile: the collapsed strip above already names the
   *  metric and is the active selection, so a title, a description and a
   *  weekly-data footnote between the click and the chart it asked for is
   *  three rows of chrome restating what was just chosen. */
  compactHeader?: boolean;
};

// Grouped so each panel mixes a tall section with a short one, rather than
// letting one panel absorb every chart: Overview = tiles + concentration,
// Balances = the two histogram sections, Growth = the two tile-only sections,
// Exchanges = the table plus its per-exchange history.
// Concentration is its own panel, not part of Overview: paired with the KPI
// tiles it made a 2085px stack — seven Top-N tiles plus a bar chart under four
// tiles — which is the same "scroll past everything to reach the last thing"
// problem the Holder Growth charts had, one level down. It reads independently
// (it is not a legend or an aggregate of the tiles above it), so it splits
// cleanly.
// Labels live in lib/terminalCopy so the desktop Dashboard and this
// one-chart Explore list don't use the same words for different jobs
// ("Overview" / "Trends" / "Flows" used to read as a second dashboard).
// Ids are unchanged — hashes and the Dashboard "Explore" buttons still land
// on the same panels. "Momentum" stays: velocity isn't a Dashboard cell.
const HOLDER_PANELS = HOLDER_EXPLORE_PANELS.map(({ id, label, hint }) => ({ id, label, title: hint }));

const WalletHoldingsWidget = ({ selectedView, onViewChange, rangeDays, onRangeDaysChange, trendsPanel, flowsPanel, panel: panelProp, onPanelChange, compactHeader = false }: WalletHoldingsWidgetProps) => {
  const { project } = useProject();
  // Combined + every chain in the project's chains[] (TEL: Ethereum, Polygon, Base, as before).
  const viewOptions = useMemo(() => chainViewOptions(project), [project]);
  const copy = useProjectCopy();
  const [expandedCexExchange, setExpandedCexExchange] = useState<string | null>(null);
  const [panelState, setPanelState] = useState("overview");
  // Controlled when a panel is passed in, internal otherwise — so the existing
  // sub-tab row keeps working untouched either way.
  const panel = panelProp ?? panelState;
  const setPanel = (next: string) => {
    setPanelState(next);
    onPanelChange?.(next);
  };
  // Shared page-wide timeframe control, repeated in every section header.
  const rangeCtl = { rangeDays, onRangeDaysChange };

  const { data, isLoading, error: queryError, refetch } = useHolderLiteSnapshot();
  // A segmented control, not four solid Buttons. Chain scope is a FILTER
  // applied across every sub-panel — as full-weight Buttons it was the loudest
  // thing in the card, louder than both the page tab and the sub-panel bar
  // below it. Reuses TierFlowDiagram's treatment verbatim, so the page's two
  // chain selectors read as the same control.
  //
  // In focus mode it is the same control, tighter, folded into the right end
  // of the sub-panel row instead of owning a row of its own: its own row put
  // ~70px of mostly-empty space between the tile that was clicked and the
  // chart it opened, on a viewport where the chart already started 640px down.
  const chainSelector = (
    <div
      className={
        compactHeader
          ? "flex flex-nowrap gap-0.5 overflow-x-auto rounded-full border border-border/60 bg-card/80 p-0.5 [-webkit-overflow-scrolling:touch]"
          : "inline-flex flex-wrap rounded-full border border-border/60 bg-card/80 p-0.5"
      }
    >
      {viewOptions.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onViewChange(option.key)}
          disabled={isLoading}
          className={`${compactHeader ? "min-h-[32px] max-xl:min-h-11 max-xl:min-w-11 shrink-0 px-2.5 text-xs" : "min-h-[44px] px-3.5 text-xs sm:text-sm"} rounded-full font-semibold transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            option.key === selectedView
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-primary"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  // Shared with HolderKpiHero, so the Retail Holders/Total TEL Held/Staked
  // TEL/CEX Balance tiles below can never show a different delta depending
  // on which component renders them — see useHeadlineTiles' doc comment.
  // Unconditionally enabled (no rangeDays > 1 gate): 1D used to fall back to
  // three different undated sources per tile; now it's the same
  // pickBaseline-derived value every other range already uses.
  const { historicalDelta, cexPrevious: cexHistoricalPrevious, events } = useHeadlineTiles({ view: selectedView, rangeDays });
  const snapshot = data as import('../hooks/useHolderSnapshot').HolderLiteSnapshot | undefined;
  const { data: cexHistory } = useCexBalanceHistory();
  const { data: growth } = useHolderGrowth({ view: selectedView, days: 365 });
  // All-time-high check needs the FULL archive, not the 365-day series above
  // — that only proves "higher than any day in the last year", which only
  // equals true all-time today because the history archive itself is under
  // a year old. Once it exceeds 365 days, reusing `growth` here would start
  // awarding a false "ATH" badge for a merely-recent local high.
  const { data: fullHistory } = useHolderGrowth({ view: selectedView, days: 36500 });
  const holderCountIsAth = useMemo(() => {
    if (selectedView !== "combined" || !fullHistory?.series?.length) return false;
    const holders = fullHistory.series.map((p) => p.holders);
    const latest = holders[holders.length - 1];
    const max = Math.max(...holders);
    return latest > 0 && latest >= max;
  }, [fullHistory, selectedView]);
  const holderAthNote = holderCountIsAth
    ? athHistoryNote(historyDays((fullHistory?.series ?? []).map((p) => Date.parse(p.timestamp))))
    : null;

  // Range-aware holder momentum: net new holders over the selected window,
  // computed within the same history series so both ends are consistent.
  const holderMomentum = useMemo(() => {
    if (!growth?.series?.length) return null;
    const pts = growth.series
      .map((p) => ({ ts: Date.parse(p.timestamp), holders: p.holders }))
      .filter((p) => Number.isFinite(p.ts))
      .sort((a, b) => a.ts - b.ts);
    if (pts.length < 2) return null;
    const latest = pts[pts.length - 1];
    // A gap in the snapshot archive can leave `baseline` far from the actual
    // target (e.g. a missed week turns "vs 7 days ago" into "vs 14 days
    // ago") — pickBaseline bails rather than silently mislabel the comparison.
    const baseline = pickBaseline(pts, rangeDays, (p) => p.ts);
    if (!baseline) return null;
    const net = latest.holders - baseline.holders;
    const days = Math.max(1, (latest.ts - baseline.ts) / 86400000);
    const pct = baseline.holders > 0 ? (net / baseline.holders) * 100 : 0;
    return { net, perDay: net / days, pct, current: latest.holders, baseline: baseline.holders, days };
  }, [growth, rangeDays]);
  const { isAdmin } = useUserRole();
  const error = queryError ? (queryError instanceof Error ? queryError.message : "Unable to load holder snapshot.") : null;

  const display = useMemo(
    () => displayResults(copy, snapshot ?? null, selectedView),
    [copy, snapshot, selectedView],
  );

  const generatedAt = snapshot?.generatedAt ?? null;
  const formattedGeneratedAt = useMemo(() => {
    if (!generatedAt) return null;
    const date = new Date(generatedAt);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }, [generatedAt]);

  const sourceDetails = useMemo(() => {
    const source = snapshot?.source;
    if (!source) return null;

    const provider = source.type ?? "Unknown";

    // New explorer format: source.chains has per-chain API hosts
    const chainApis = source.chains
      ? [...new Set(Object.values(source.chains).map((c) => formatHost(c?.api)).filter(Boolean))]
      : [];
    const host = chainApis.length > 0 ? chainApis.join(", ") : formatHost(source.upstream);
    const queryLabel = source.queryId ? `Query ${source.queryId}` : null;

    return formatSourceLabel([provider, host, queryLabel]);
  }, [snapshot?.source]);

  const selectionLabel = viewOptions.find((option) => option.key === selectedView)?.label ?? "Selected";

  const previewMetrics = display?.metrics;

  return (
    <Card className="premium-surface-card">
      {/* No Collapsible: this widget is the sole content of the "Holders" tab,
          so a collapse control here only duplicates the tab that already
          selects it — and its collapsed preview cost height on every load. */}
      <CardHeader className={`holders-header-snapshot ${compactHeader ? "hidden" : ""}`}>
          <CardTitle className="flex items-center gap-2 text-xl sm:text-2xl font-bold tracking-tight">
            <span className="p-1.5 rounded-xl bg-primary/12 border border-primary/20 shrink-0">
              <Users className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
            </span>
            Holder Snapshot
            <MethodologyInfo section="holderSnapshot" />
          </CardTitle>
          <CardDescription className="text-base text-muted-foreground mt-2">
            Retail distribution across {copy.name}&apos;s supported chains sourced from the scheduled snapshot.
          </CardDescription>
          <p className="text-xs text-muted-foreground/80 mt-1">
            * Data is updated weekly and may not reflect real-time changes. For the most accurate information, verify directly on-chain.
          </p>
      </CardHeader>
          <CardContent className={compactHeader ? "space-y-3 p-3 pt-3" : "space-y-6 pt-6"}>
            {/* In focus mode this row survives only below lg, where folding the
                chain filter into the sub-panel row leaves the panel labels
                about 120px and clips them ("Overvie…"). Desktop has the width
                to put both on one line; a phone does not, and the row it would
                save there is cheaper than the selector it would break. */}
            <div
              className={`flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between ${
                compactHeader ? "lg:hidden" : ""
              }`}
            >
              {chainSelector}
            </div>

            {error && (
              <Alert variant="destructive" className="border-dashed">
                <AlertTitle>Snapshot unavailable</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>We couldn&apos;t load the latest holder data. This is usually temporary.</p>
                  <p className="text-xs opacity-80">{error}</p>
                  <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void refetch()}>
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {isLoading && !snapshot && (
              <div role="status" aria-label="Loading latest holder data" className="space-y-3" data-testid="panel-skeleton">
                <div className="flex gap-2">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-9 w-24 rounded-md bg-muted/70 animate-pulse" />
                  ))}
                </div>
                <div className="h-5 w-48 rounded bg-muted/70 animate-pulse" />
                <div className="h-64 sm:h-80 w-full rounded-2xl bg-muted/50 animate-pulse" />
                <span className="sr-only">Loading latest holder data…</span>
              </div>
            )}

            {snapshot && display && (
              <SubPanelTabs
                panels={HOLDER_PANELS}
                value={panel}
                onValueChange={setPanel}
                trailing={compactHeader ? <div className="hidden lg:block">{chainSelector}</div> : undefined}
              >
              <TabsContent value="overview" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {renderMetrics(
                  copy,
                  display,
                  snapshot.totals,
                  snapshot.cex,
                  selectedView,
                  historicalDelta ?? null,
                  baselineLabel(historicalDelta?.referenceDate),
                  cexHistoricalPrevious,
                  holderCountIsAth,
                  events.holders,
                  events.cex,
                  events.retailBalance,
                  holderAthNote,
                )}
              </TabsContent>

              <TabsContent value="concentration" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {renderConcentration(
                  copy,
                  display,
                  rangeCtl,
                  rangeDays,
                  historicalDelta?.concentrationTop ?? null,
                  historicalDelta?.totalBalance ?? null,
                  historicalDelta?.referenceDate ?? null,
                  events.concentration,
                )}
              </TabsContent>

              <TabsContent value="balances" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {renderBalanceInsights(copy, display.balanceStats, rangeCtl)}
              </TabsContent>

              <TabsContent value="staking" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {renderStakingInsights(copy, display.stakingStats, display.stakingDistribution, rangeCtl)}
              </TabsContent>

              <TabsContent value="growth" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {renderVelocity(
                  copy,
                  holderMomentum,
                  selectionLabel,
                  RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`,
                  rangeCtl,
                  selectedView === "combined"
                    ? {
                        total: historicalDelta?.latestCumulativeHolders ?? null,
                        newInRange:
                          historicalDelta?.latestCumulativeHolders != null && historicalDelta?.cumulativeHolders != null
                            ? historicalDelta.latestCumulativeHolders - historicalDelta.cumulativeHolders
                            : null,
                      }
                    : null,
                )}
                {renderOverlap(selectedView === "combined" ? snapshot.overlap : null, rangeCtl)}
              </TabsContent>

              <TabsContent value="trends" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {trendsPanel}
              </TabsContent>

              <TabsContent value="flows" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {flowsPanel}
              </TabsContent>

              <TabsContent value="exchanges" className={`${compactHeader ? "mt-2 space-y-3" : "mt-4 space-y-6"} focus-visible:outline-none`}>
                {renderCexFlows(copy, snapshot.cex, selectedView, expandedCexExchange, (name) => setExpandedCexExchange((prev) => (prev === name ? null : name)), rangeDays, onRangeDaysChange, cexHistory)}
                <CexHistoryTiles rangeDays={rangeDays} />
              </TabsContent>
              </SubPanelTabs>
            )}

            {snapshot && !display && !error && (
              <Alert className="border-dashed">
                <AlertTitle>No data available</AlertTitle>
                <AlertDescription>
                  The selected view does not have any retail balances yet. Try refreshing the snapshot or choosing another chain.
                </AlertDescription>
              </Alert>
            )}

            {/* Provenance, not navigation. This block (generated-at, source,
                the three RPC links in ChainStatusBar, the range note) used to
                sit between the chain buttons and the sub-panel selector, which
                put ~300px of "where the data came from" ahead of the control
                that picks WHAT you see — on a phone the selector landed below
                the fold. It stays in full, just after the panel it describes. */}
            <CompactProvenance
              className="border-t border-border/40 sm:hidden"
              snapshotLabel={formattedGeneratedAt ? `Snapshot generated ${formattedGeneratedAt}` : "Snapshot timestamp unavailable"}
              sourceLabel={sourceDetails ? `Source: ${sourceDetails}` : "Source unavailable"}
            >
              {isAdmin && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1 min-h-11 gap-2"
                  onClick={() => {
                    void refetch();
                  }}
                  disabled={isLoading}
                >
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Refresh
                </Button>
              )}
            </CompactProvenance>
            <div className="flex flex-col gap-1.5 border-t border-border/40 pt-4 max-sm:hidden">
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  {formattedGeneratedAt
                    ? `Snapshot generated ${formattedGeneratedAt}`
                    : "Snapshot timestamp unavailable"}
                </div>
                <div className="flex items-center gap-2">
                  <Globe2 className="h-4 w-4" />
                  {sourceDetails ? `Source: ${sourceDetails}` : "Source unavailable"}
                </div>
                {isAdmin && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => {
                      void refetch();
                    }}
                    disabled={isLoading}
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Refresh
                  </Button>
                )}
              </div>
              <ChainStatusBar />
            </div>
          </CardContent>
    </Card>
  );
};

export default WalletHoldingsWidget;
