import { useMemo, useState } from "react";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { SubPanelTabs } from "@/components/SubPanelTabs";
import { TabsContent } from "@/components/ui/tabs";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useHolderGrowth } from "@/hooks/useHolderGrowth";
import { useHolderHistoricalDelta } from "@/hooks/useHolderHistoricalDelta";
import { type DisplaySelection } from "@/hooks/useHolderSnapshot";
import { useProject } from "@/hooks/useProject";
import { chainViewLabel } from "@/lib/chainViews";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import "@/lib/rechartsMotion";
import { Clock, Database, Layers, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { formatRelativeAge, formatShortDate } from "@/lib/format";
import { InfoTooltip } from "@/components/InfoTooltip";
import { useClassificationChangelog, getEventsAffecting } from "@/hooks/useClassificationChangelog";
import { insertGapBreaks } from "@/lib/seriesGaps";
import { V3_STAKING_DEPLOY_DATE, v3StakingGapEvents } from "@/lib/staking";
import { computeSeriesDomain, computeBreakAwareDomain, activeKeys } from "@/lib/chartDomain";
import { getSeriesBreaks, insertBreakSpacers, SERIES_BREAK_LABEL } from "@/lib/seriesBreaks";

type HolderGrowthWidgetProps = {
  selectedView: DisplaySelection;
  rangeDays: number;
  onRangeDaysChange: (days: number) => void;
};



const holdersChartConfig = (ticker: string) => ({
  holders: {
    label: `Wallets with >0 ${ticker}`,
    color: "hsl(var(--primary))",
  },
});

// No blended "Total" series here by design (removed 2026-08-22). Summing these
// three is invariant to the movement this chart exists to show — 1B rotating
// from exchanges into self-custody leaves a total flat while Retail and CEX
// move in opposite directions — and it inherited every component's measurement
// gaps. Plot the components; the rotation is the signal. See tasks/todo.md.
const balanceChartConfig = {
  retail: {
    label: "Retail Only",
    color: "hsl(217 91% 60%)",
  },
  cex: {
    label: "CEX Balance",
    color: "hsl(28 90% 55%)",
  },
  dex: {
    label: "DEX Liquidity",
    color: "hsl(152 60% 42%)",
  },
} as const;

type BalanceSeriesKey = keyof typeof balanceChartConfig;

const stakingChartConfig = {
  stakingTotal: { label: "Total staked", color: "hsl(var(--primary))" },
  staking: { label: "Legacy contract", color: "hsl(var(--muted-foreground))" },
  stakingV3: { label: "v3 StakingModule", color: "hsl(var(--ha-accent))" },
};
const V3_DEPLOY_MS = Date.parse(V3_STAKING_DEPLOY_DATE);

/** Dot only where a series has a value with no neighbour (no line drawn). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isolatedDot = (rows: Array<Record<string, number | null>>, key: string, color: string) => (props: any) => {
  const i = props?.index as number;
  const has = (j: number) => rows[j] != null && rows[j][key] != null;
  return has(i) && !has(i - 1) && !has(i + 1) && Number.isFinite(props?.cx) ? (
    <circle key={`${key}-${i}`} cx={props.cx} cy={props.cy} r={3.5} fill={color} />
  ) : (
    <g key={`${key}-${i}`} />
  );
};

const formatInteger = (value: number) => new Intl.NumberFormat().format(value);

// Tier is picked from the MAGNITUDE while the printed number keeps its sign, so
// a negative delta renders "-1.23B <ticker>". Testing `value >= 1e9` directly (as this
// did before the Change view existed) sends every negative straight to the
// integer branch and prints "-1,234,567,890 <ticker>".
const compactAmount = (value: number, unit: string) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B ${unit}`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M ${unit}`;
  return `${new Intl.NumberFormat().format(Math.round(value))} ${unit}`;
};

// Explicit +/- so a rebased delta reads as a direction, not just a quantity.
const signedAmount = (value: number, unit: string) => {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${compactAmount(Math.abs(value), unit)}`;
};

type BalanceMode = "balance" | "change";

const HolderGrowthWidget = ({ selectedView, rangeDays, onRangeDaysChange }: HolderGrowthWidgetProps) => {
  const { project } = useProject();
  // Label from the project's chains[] (TEL: Combined / Ethereum / Polygon / Base).
  const config = { label: chainViewLabel(project, selectedView) };
  const { ticker } = useProjectCopy();
  const chartConfig = useMemo(() => holdersChartConfig(ticker), [ticker]);
  const formatCompactAmount = (value: number) => compactAmount(value, ticker);
  const formatSignedAmount = (value: number) => signedAmount(value, ticker);

  const { data, isLoading, error } = useHolderGrowth({
    view: selectedView,
    days: rangeDays,
  });

  const { data: changelog } = useClassificationChangelog();

  // Single-baseline resolution shared with HolderKpiHero.tsx and
  // DistributionAnalysisWidget.tsx — pickBaseline() (src/lib/baseline.ts)
  // finds the archive entry CLOSEST to the target date, with a tolerance
  // rejection, instead of useHolderGrowth's cutoff-filter + first-survivor
  // approach below (which picks the first entry AFTER a target, so a gap in
  // the archive right after the target date silently skips straight to the
  // next available snapshot days later). Using two different baseline
  // algorithms let this widget's delta badges disagree with the hero tile's
  // for the same range — see lessons.md-style precedent in
  // useHeadlineTiles.ts's doc comment, which this hook already fixed for
  // the hero/WalletHoldingsWidget tiles but never reached this widget.
  const { data: historicalDelta } = useHolderHistoricalDelta({
    view: selectedView,
    days: rangeDays ?? 0,
    enabled: (rangeDays ?? 0) >= 1,
  });

  const chartData = useMemo(() => {
    const series = data?.series ?? [];
    return series
      .map((point) => {
        const timestamp = Date.parse(point.timestamp);
        const holders = Number(point.holders);
        if (!Number.isFinite(timestamp) || !Number.isFinite(holders)) return null;
        const cumulativeHolders = Number.isFinite(point.cumulativeHolders)
          ? (point.cumulativeHolders as number)
          : null;
        return { timestamp, holders, cumulativeHolders, gapDays: point.gapDays ?? null };
      })
      .filter((entry): entry is {
        timestamp: number;
        holders: number;
        cumulativeHolders: number | null;
        gapDays: number | null;
      } => !!entry)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [data?.series]);

  // Text alternative for the holders line: start, end and net change in
  // one sentence (the chart's points are mouse-only tooltips).
  const holdersAriaSummary = useMemo(() => {
    if (chartData.length === 0) return "Retail holders: no data for this range.";
    const f = chartData[0];
    const l = chartData[chartData.length - 1];
    const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const n = new Intl.NumberFormat();
    const d = l.holders - f.holders;
    const change = d === 0 ? "no net change" : `${d > 0 ? "up" : "down"} ${n.format(Math.abs(d))}`;
    return `Retail holders line chart: ${n.format(f.holders)} on ${day.format(f.timestamp)} to ${n.format(l.holders)} on ${day.format(l.timestamp)}, ${change}.`;
  }, [chartData]);

  // Render-only view of chartData: breaks the line across days the pipeline
  // never sampled instead of drawing a straight segment through them (see
  // src/lib/seriesGaps.ts and the 2026-08-11-pipeline-outage changelog event).
  // Kept separate from chartData so the domain, delta, and tick calculations
  // below keep operating on real observations only and never see a null.
  const holdersBreaks = useMemo(
    () => getSeriesBreaks(changelog, ["retail.count", "holderCount"], chartData[0]?.timestamp, chartData[chartData.length - 1]?.timestamp),
    [changelog, chartData],
  );
  const holdersLineData = useMemo(
    () =>
      insertBreakSpacers(
        insertGapBreaks(chartData, ["holders", "cumulativeHolders"]) as Record<string, unknown>[],
        holdersBreaks.map((b) => b.t),
        "timestamp",
        ["holders", "cumulativeHolders"],
      ) as typeof chartData,
    [chartData, holdersBreaks],
  );

  const stakingChartData = useMemo(() => {
    const series = data?.stakingSeries ?? [];
    const num = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : null);
    return series
      .map((point) => {
        const timestamp = Date.parse(point.timestamp);
        if (!Number.isFinite(timestamp)) return null;
        // Number(null) is 0. A program-only row has no legacy figure; turning
        // that into 0 would pin the axis at zero and hide the staked total.
        const staking = num(point.staking);
        const stakingV3 = timestamp >= V3_DEPLOY_MS ? num(point.stakingV3) : null;
        const stakingTotal = num(point.stakingTotal);
        if (staking == null && stakingV3 == null && stakingTotal == null) return null;
        return { timestamp, staking, stakingV3, stakingTotal };
      })
      .filter(
        (entry): entry is { timestamp: number; staking: number | null; stakingV3: number | null; stakingTotal: number | null } => !!entry,
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [data?.stakingSeries]);

  const stakingStats = useMemo(() => {
    const none = { latest: null, change: null, changePct: null, gap: [] as ReturnType<typeof v3StakingGapEvents> };
    if (stakingChartData.length === 0) return none;
    const last = stakingChartData[stakingChartData.length - 1];
    // Split only when both channels were measured. A program-only series
    // (Solana staking on stakingV3Balance, no legacy contract) is one total.
    const hasV3 = (last.staking ?? 0) > 0 && (last.stakingV3 ?? 0) > 0;
    const latest = last.stakingTotal ?? last.staking;
    // Same pickBaseline-sourced baseline as the hero's Staked TEL tile — see
    // the Wallets `stats` comment above for why this matters. With v3 in the
    // total, a baseline inside the unmeasured v3 window has no honest delta.
    if (hasV3 && historicalDelta?.referenceDate) {
      const gap = v3StakingGapEvents(historicalDelta.referenceDate, historicalDelta.stakingV3Balance, undefined, ticker);
      if (gap.length) return { ...none, latest, gap };
    }
    const baseline = last.stakingTotal != null
      ? historicalDelta?.stakingTotal ?? null
      : historicalDelta?.stakingBalance ?? null;
    if (baseline !== null && latest != null) {
      const change = latest - baseline;
      const changePct = baseline > 0 ? (change / baseline) * 100 : null;
      return { latest, change, changePct, gap: none.gap };
    }
    const first = stakingChartData[0].stakingTotal ?? stakingChartData[0].staking;
    if (first == null || latest == null) return { ...none, latest, gap: hasV3 ? v3StakingGapEvents(stakingChartData[0].timestamp, null, undefined, ticker) : none.gap };
    const change = latest - first;
    const changePct = first > 0 ? (change / first) * 100 : null;
    return { latest, change, changePct, gap: none.gap };
  }, [stakingChartData, historicalDelta, ticker]);

  const showStakingSplit = stakingChartData.some((p) => (p.staking ?? 0) > 0 && (p.stakingV3 ?? 0) > 0);

  const stakingYDomain = useMemo((): [number, number] | ["auto", "auto"] => {
    if (stakingChartData.length === 0) return ["auto", "auto"];
    const values = stakingChartData.flatMap((p) => [p.staking, p.stakingTotal, p.stakingV3]).filter((v): v is number => v != null);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);
    const padding = range * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [stakingChartData]);

  const balanceChartData = useMemo(() => {
    const series = data?.balanceSeries ?? [];
    return series
      .map((point) => {
        const timestamp = Date.parse(point.timestamp);
        if (!Number.isFinite(timestamp)) return null;
        // Deliberately NOT Number(v): Number(null) is 0, which passes
        // Number.isFinite and would turn "unmeasured on this date" into
        // "was zero" — the exact cliff the null is there to prevent.
        const num = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : null);
        return { timestamp, retail: point.retail, cex: num(point.cex), dex: num(point.dex) };
      })
      .filter((entry): entry is { timestamp: number; retail: number; cex: number | null; dex: number | null } => !!entry)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [data?.balanceSeries]);

  // Toggleable series — all default-on. Total is derived client-side from
  // the other three (see useHolderGrowth.ts), never stored, so it can't
  // drift from its components.
  const [visibleBalanceSeries, setVisibleBalanceSeries] = useState<Record<BalanceSeriesKey, boolean>>({
    retail: true,
    cex: true,
    dex: true,
  });
  const toggleBalanceSeries = (key: BalanceSeriesKey) =>
    setVisibleBalanceSeries((prev) => ({ ...prev, [key]: !prev[key] }));

  // DEX and CEX history is sparse until the respective backfills have run
  // (see tasks/todo.md) — a single snapshot can't show a trend.
  const hasDexLiquidityHistory = balanceChartData.filter((p) => p.dex !== null).length >= 2;
  const hasCexHistory = balanceChartData.filter((p) => p.cex !== null).length >= 2;

  // A series being toggled ON is not the same as it being DRAWN: a sparse series
  // is suppressed regardless of its chip. Both the Y domain and the <Line> list
  // must key off THIS, not off visibleBalanceSeries — computing "is it showing?"
  // in two places is what let a hidden single DEX point (0.93B, the only one
  // populated) drag the axis floor from 17.4B down to 0 and squash all three
  // real lines into the top fifth of the plot.
  const renderedBalanceSeries = useMemo(
    (): Record<BalanceSeriesKey, boolean> => ({
      retail: visibleBalanceSeries.retail,
      cex: visibleBalanceSeries.cex && hasCexHistory,
      dex: visibleBalanceSeries.dex && hasDexLiquidityHistory,
    }),
    [visibleBalanceSeries, hasCexHistory, hasDexLiquidityHistory],
  );

  // Three charts that used to stack vertically inside this one card, which on
  // a phone meant scrolling past two of them to reach the third. One at a
  // time behind a selector instead — and because inactive TabsContent
  // unmounts, the hidden charts leave the DOM entirely rather than merely
  // being scrolled past.
  const GROWTH_PANELS = [
    { id: "wallets", label: "Wallets" },
    { id: "balance", label: "Balance" },
    { id: "staked", label: "Staked" },
  ];
  const [growthPanel, setGrowthPanel] = useState("wallets");

  const [balanceMode, setBalanceMode] = useState<BalanceMode>("balance");
  // Balance mode only. Retail (~67.7B) beside DEX (~0.94B) is a 70x spread that
  // a linear axis flattens; a log axis fixes that but cannot render the signed
  // deltas Change mode plots, so the control is hidden there rather than
  // silently producing a wrong picture.
  const [logScale, setLogScale] = useState(false);

  // In "change" mode each series is rebased to its own first in-range value, so
  // every line starts at 0 and the axis spans actual movement (~±3B) rather than
  // absolute levels (17-93B). That's ~25x more resolution, and it's what makes
  // Retail/CEX/Total comparable despite differing ~4x in size. Rebasing lives
  // here rather than in useHolderGrowth because the baseline depends on the
  // selected range, which that hook has already filtered by this point.
  const balanceDisplayData = useMemo(() => {
    if (balanceMode === "balance") return balanceChartData;
    // Each series gets its OWN baseline — the first point where that series has
    // a value. CEX and DEX can start later than Retail (sparse backfills), and
    // rebasing them to a date they don't cover would offset the whole line.
    const firstOf = (pick: (p: (typeof balanceChartData)[number]) => number | null) => {
      const hit = balanceChartData.find((p) => {
        const v = pick(p);
        return v !== null && Number.isFinite(v);
      });
      return hit ? pick(hit) : null;
    };
    const baseRetail = firstOf((p) => p.retail);
    const baseCex = firstOf((p) => p.cex);
    const baseDex = firstOf((p) => p.dex);
    return balanceChartData.map((p) => ({
      timestamp: p.timestamp,
      // Null must survive rebasing: in JS `null - 5` is -5, not NaN, so a bare
      // subtraction would turn an unmeasured point into a real-looking -85B.
      retail: p.retail === null || baseRetail === null ? null : p.retail - baseRetail,
      cex: p.cex !== null && baseCex !== null ? p.cex - baseCex : null,
      dex: p.dex !== null && baseDex !== null ? p.dex - baseDex : null,
    }));
  }, [balanceChartData, balanceMode]);

  const holdersChangelogEvents = useMemo(() => {
    if (chartData.length === 0) return [];
    return getEventsAffecting(changelog, "retail.count", chartData[0].timestamp, chartData[chartData.length - 1].timestamp);
  }, [changelog, chartData]);

  const balanceChangelogEvents = useMemo(() => {
    if (balanceChartData.length === 0) return [];
    return getEventsAffecting(changelog, "totalHeld", balanceChartData[0].timestamp, balanceChartData[balanceChartData.length - 1].timestamp);
  }, [changelog, balanceChartData]);

  const stats = useMemo(() => {
    if (chartData.length === 0) {
      return {
        latest: null,
        change: null,
        changePct: null,
      };
    }

    const latest = chartData[chartData.length - 1]?.holders ?? null;
    if (latest === null) {
      return { latest, change: null, changePct: null };
    }

    // Baseline sourced from useHolderHistoricalDelta/pickBaseline — same
    // resolution the hero tile uses — not chartData[0], so the two never
    // disagree due to picking different baseline dates around an archive
    // gap. The delta itself reads NET holderCount change — same metric the
    // hero tile and TierFlowDiagram's "Retail Wallets, net change" panel
    // show off the same baseline, so all three agree. (cumulativeHolders —
    // gross new-ever-retail wallets, ignoring churn — is surfaced separately
    // as a tooltip below, not as this primary badge; see HolderKpiHero.tsx
    // for why showing it here instead was tried and reverted.)
    if (historicalDelta?.holderCount !== null && historicalDelta?.holderCount !== undefined) {
      const change = latest - historicalDelta.holderCount;
      const changePct = historicalDelta.holderCount > 0 ? (change / historicalDelta.holderCount) * 100 : null;
      return { latest, change, changePct };
    }

    // Fallback: pickBaseline rejected every archive entry (nothing within
    // tolerance for this range) — better to show something than nothing.
    const first = chartData[0]?.holders ?? null;
    if (first === null) {
      return { latest, change: null, changePct: null };
    }
    const change = latest - first;
    const changePct = first > 0 ? (change / first) * 100 : null;
    return { latest, change, changePct };
  }, [chartData, historicalDelta]);

  // Secondary, clearly-labeled context only — see HolderKpiHero.tsx's
  // identical comment for why this isn't the primary badge.
  const cumulativeHoldersTooltip = useMemo(() => {
    if (selectedView !== "combined") return null;
    const latestCumulative = historicalDelta?.latestCumulativeHolders ?? null;
    const baselineCumulative = historicalDelta?.cumulativeHolders ?? null;
    if (latestCumulative === null || baselineCumulative === null || !historicalDelta?.referenceDate) return null;
    const delta = latestCumulative - baselineCumulative;
    return `${delta >= 0 ? "+" : ""}${formatInteger(delta)} wallets have newly appeared since ${historicalDelta.referenceDate}, before accounting for wallets that left or were reclassified (e.g. later identified as an exchange). The net change above reflects the current total's actual movement.`;
  }, [historicalDelta, selectedView]);

  const balanceStats = useMemo(() => {
    // Retail, not a blended total — this header sits above a chart that no
    // longer draws one. It also can't use historicalDelta.totalHeld as its
    // baseline any more: that field is retail + CEX, so diffing it against a
    // retail-only latest would report the entire ~20B CEX book as a change.
    // First/last MEASURED points, since strictNullChecks is off here and in JS
    // `null - 5` silently evaluates to -5 rather than throwing.
    const measured = balanceChartData.filter((p): p is typeof p & { retail: number } => p.retail !== null);
    if (measured.length === 0) return { latest: null, change: null, changePct: null };
    const latest = measured[measured.length - 1].retail;
    const first = measured[0].retail;
    const change = latest - first;
    const changePct = first > 0 ? (change / first) * 100 : null;
    return { latest, change, changePct };
  }, [balanceChartData]);

  // renderedBalanceSeries, NOT visibleBalanceSeries — a series toggled on but
  // suppressed for sparseness draws no line, so it must not set a bound either.
  // See src/lib/chartDomain.ts (and its regression test) for the bug this fixes.
  const balanceYDomain = useMemo(
    () =>
      computeSeriesDomain(balanceDisplayData, activeKeys(renderedBalanceSeries), {
        allowNegative: balanceMode === "change",
        log: balanceMode === "balance" && logScale,
      }),
    [balanceDisplayData, renderedBalanceSeries, balanceMode, logScale],
  );

  const yDomain = useMemo((): [number, number] | ["auto", "auto"] => {
    if (chartData.length === 0) return ["auto", "auto"];
    // A declared methodology break must not decide the axis (see seriesBreaks.ts).
    if (holdersBreaks.length > 0) {
      const d = computeBreakAwareDomain(chartData, ["holders"], holdersBreaks.map((b) => b.t), "timestamp");
      if (typeof d[0] === "number") return d as [number, number];
    }
    const holders = chartData.map((point) => point.holders);
    const min = Math.min(...holders);
    const max = Math.max(...holders);
    const range = Math.max(1, max - min);
    const padding = range * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [chartData, holdersBreaks]);

  // Compute explicit tick timestamps so Recharts renders exactly what we want.
  // 7D → daily; 30D → weekly (every 7 days); 90D → biweekly; YTD/1Y → 1st of each month.
  const xTicks = useMemo(() => {
    if (chartData.length === 0) return [];
    const last = chartData[chartData.length - 1].timestamp;
    const first = chartData[0].timestamp;

    // All tick math in UTC: the feed's rows sit on UTC midnights, and the
    // axis formatters render in UTC, so a local-midnight tick would land a
    // few hours off its row (and read as the previous day west of UTC).
    if (rangeDays <= 7) {
      // One tick per day
      const ticks: number[] = [];
      for (let t = first; t <= last + 86400000; t += 86400000) {
        const d = new Date(t);
        ticks.push(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      }
      return [...new Set(ticks)];
    }

    if (rangeDays <= 30) {
      // Weekly ticks — Sundays
      const ticks: number[] = [];
      const d = new Date(first);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // roll back to Sunday
      d.setUTCHours(0, 0, 0, 0);
      while (d.getTime() <= last + 86400000) {
        if (d.getTime() >= first) ticks.push(d.getTime());
        d.setUTCDate(d.getUTCDate() + 7);
      }
      return ticks.length ? ticks : [first, last];
    }

    if (rangeDays <= 90) {
      // Biweekly ticks — every 14 days from start
      const ticks: number[] = [];
      const d = new Date(first);
      d.setUTCHours(0, 0, 0, 0);
      while (d.getTime() <= last + 86400000) {
        ticks.push(d.getTime());
        d.setUTCDate(d.getUTCDate() + 14);
      }
      return ticks;
    }

    // YTD / 1Y — 1st of each month
    const ticks: number[] = [];
    const d = new Date(first);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= last + 86400000) {
      ticks.push(d.getTime());
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return ticks;
  }, [chartData, rangeDays]);

  const tickFormatter = useMemo(() => {
    if (rangeDays <= 7) return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    if (rangeDays <= 90) return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    return new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  }, [rangeDays]);

  const tooltipFormatter = useMemo(() => {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
  }, []);

  const formatDateValue = (value: unknown, formatter: Intl.DateTimeFormat) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return formatter.format(new Date(value));
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return formatter.format(new Date(parsed));
      }
    }
    return "";
  };

  const changeTone = stats.change !== null && stats.change >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400";
  const ChangeIcon = stats.change !== null && stats.change >= 0 ? TrendingUp : TrendingDown;

  return (
    <div>
      <div>
        <div>
          <div className="flex items-center gap-2 text-base sm:text-lg font-bold tracking-tight flex-wrap">
            <span className="p-1.5 rounded-xl bg-emerald-500/12 border border-emerald-500/20 shrink-0">
              <TrendingUp className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
            </span>
            Holder Growth
                      </div>
          <p data-panel-desc className="text-sm text-muted-foreground mt-1.5">
            Holder history based on the scheduled snapshot archive.
          </p>
        </div>
        <div>
          <div className="space-y-4 pt-4">
            <SubPanelTabs panels={GROWTH_PANELS} value={growthPanel} onValueChange={setGrowthPanel} variant="filter">
            <TabsContent value="wallets" className="mt-4 space-y-4 focus-visible:outline-none">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">{config.label}</Badge>
                {stats.latest !== null && (
                  <span>Wallets: {formatInteger(stats.latest)}</span>
                )}
                {stats.change !== null && stats.changePct !== null && (
                  <span className={`inline-flex items-center gap-1 ${changeTone}`}>
                    <ChangeIcon className="h-4 w-4" />
                    {stats.change >= 0 ? "+" : ""}
                    {formatInteger(stats.change)} ({stats.changePct.toFixed(2)}%)
                    {cumulativeHoldersTooltip && <InfoTooltip text={cumulativeHoldersTooltip} />}
                  </span>
                )}
                {holdersChangelogEvents.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    Classification changed in this range
                    <InfoTooltip
                      text={`The dashed marker(s) on this chart mark a reclassification, not real holder movement:\n\n${holdersChangelogEvents.map((e) => `${e.date}: ${e.summary}`).join("\n\n")}`}
                    />
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-border/50 bg-muted/10 p-4">
              {isLoading && (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading holder growth...
                </div>
              )}

              {/* The page header already carries the full stale-data notice
                  (StaleDataBanner); repeating it here as a red error inside
                  the chart read as "this chart is broken" when the numbers
                  are fine as of their date. A one-line amber note keeps the
                  context next to the line without the alarm. */}
              {!isLoading && !error && data?.feedError && (
                <p className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-50 px-2.5 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {(() => {
                    const rel = formatRelativeAge(data.updatedAt);
                    const date = formatShortDate(data.updatedAt);
                    return date ? `Last updated ${date}${rel ? ` (${rel})` : ""}` : "Data feed delayed";
                  })()}
                </p>
              )}

              {!isLoading && error && (
                <Alert variant="destructive" className="border-dashed">
                  <AlertTitle>Unable to load holder growth</AlertTitle>
                  <AlertDescription>{error instanceof Error ? error.message : "Unexpected error"}</AlertDescription>
                </Alert>
              )}

              {!isLoading && !error && chartData.length === 0 && (
                <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                  No holder history available for this range.
                </div>
              )}

              {!isLoading && !error && chartData.length > 0 && (
                <div className="h-56 w-full sm:h-64" role="img" aria-label={holdersAriaSummary} data-testid="holder-growth-chart">
                  <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <LineChart data={holdersLineData}>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="timestamp"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        scale="time"
                        ticks={xTicks}
                        tickFormatter={(value) => formatDateValue(value, tickFormatter)}
                        tickMargin={8}
                      />
                      <YAxis
                        // Whole numbers only: the domain's "nice" ticks are fractional
                        // (97,235.75) and, at the default 60px axis width, the
                        // leading digits were clipped off ("0,053.25").
                        tickFormatter={(value) => formatInteger(Math.round(value))}
                        domain={yDomain}
                        allowDataOverflow={holdersBreaks.length > 0}
                        tickMargin={8}
                        width={64}
                      />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            labelFormatter={(value) => formatDateValue(value, tooltipFormatter)}
                          />
                        }
                      />
                      <Line
                        dataKey="holders"
                        type="monotone"
                        stroke="var(--color-holders)"
                        strokeWidth={2}
                        dot={false}
                      />
                      {holdersBreaks.map((b) => (
                        <ReferenceLine
                          key={`break-${b.t}`}
                          x={b.t}
                          stroke="hsl(var(--ha-warning))"
                          strokeDasharray="2 3"
                          label={{ value: SERIES_BREAK_LABEL, position: "insideTopRight", fill: "hsl(var(--ha-warning))", fontSize: 10 }}
                        />
                      ))}
                      {holdersChangelogEvents.filter((e) => !e.breaksSeries).map((event) => {
                        const eventMs = Date.parse(event.date);
                        if (!Number.isFinite(eventMs)) return null;
                        return (
                          <ReferenceLine
                            key={event.id}
                            x={eventMs}
                            stroke="hsl(var(--muted-foreground))"
                            strokeDasharray="4 4"
                            label={{ value: "Reclassified", position: "insideTopRight", fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          />
                        );
                      })}
                    </LineChart>
                  </ChartContainer>
                </div>
              )}
            </div>

            </TabsContent>

            {/* Balance by holder type over time. The pt-4/border-t that used to
                separate these stacked sections is gone with the stack — the
                selector above now marks the boundary. */}
            <TabsContent value="balance" className="mt-4 space-y-4 focus-visible:outline-none">
            <div>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{ticker} Balance by Holder Type</span>
                  {selectedView !== "combined" ? (
                    <span className="text-xs text-muted-foreground">(combined view only)</span>
                  ) : (
                    <>
                      {balanceStats.latest !== null && (
                        <span>Retail {formatCompactAmount(balanceStats.latest)}</span>
                      )}
                      {balanceStats.change !== null && balanceStats.changePct !== null && (
                        <span className={`inline-flex items-center gap-1 ${balanceStats.change >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                          {balanceStats.change >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                          {balanceStats.change >= 0 ? "+" : ""}
                          {formatCompactAmount(Math.abs(balanceStats.change))}
                        </span>
                      )}
                      {balanceChangelogEvents.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          Classification changed in this range
                          <InfoTooltip
                            text={`The dashed marker(s) on this chart mark a reclassification, not real balance movement:\n\n${balanceChangelogEvents.map((e) => `${e.date}: ${e.summary}`).join("\n\n")}`}
                          />
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              {selectedView === "combined" && balanceChartData.length > 0 && (
                <div className="flex items-center gap-2 mb-3 overflow-x-auto sm:flex-wrap sm:overflow-visible [-webkit-overflow-scrolling:touch]">
                  {/* Balance = absolute levels; Change = each series rebased to 0 at
                      the start of the range, which is what makes accumulation vs
                      selling legible when the series differ ~4x in size.
                      Below sm this row scrolls instead of wrapping to 3 lines —
                      same overflow-x-auto/flex-nowrap pattern as SubPanelTabs — since
                      five controls don't fit one mobile-width line and wrapping cost
                      ~230px of vertical chrome before any chart pixel. */}
                  <div className="inline-flex shrink-0 rounded-full border border-border/60 bg-card/80 p-0.5 mr-1">
                    {([["balance", "Balance"], ["change", "Change"]] as const).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setBalanceMode(key)}
                        className={`min-h-[44px] shrink-0 text-xs font-semibold rounded-full px-3 py-1 transition-colors whitespace-nowrap ${
                          balanceMode === key
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-primary"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {balanceMode === "balance" && (
                    <button
                      type="button"
                      onClick={() => setLogScale((prev) => !prev)}
                      aria-pressed={logScale}
                      className={`min-h-[44px] shrink-0 whitespace-nowrap rounded-full border px-3 text-xs font-semibold transition-colors mr-1 ${
                        logScale
                          ? "border-transparent bg-primary text-primary-foreground"
                          : "border-border/60 text-muted-foreground hover:text-primary"
                      }`}
                    >
                      Log scale
                    </button>
                  )}
                  {(Object.keys(balanceChartConfig) as BalanceSeriesKey[]).map((key) => {
                    const active = visibleBalanceSeries[key];
                    const disabled =
                      (key === "dex" && !hasDexLiquidityHistory) || (key === "cex" && !hasCexHistory);
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleBalanceSeries(key)}
                        className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                          disabled
                            ? "opacity-40 cursor-not-allowed border-border/40 text-muted-foreground"
                            : active
                              ? "bg-card text-foreground border-2"
                              : "border-border/60 text-muted-foreground hover:text-foreground"
                        }`}
                        aria-pressed={active}
                        style={active && !disabled ? { borderColor: balanceChartConfig[key].color } : undefined}
                        title={disabled ? "Not enough history yet" : undefined}
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: balanceChartConfig[key].color }}
                        />
                        {balanceChartConfig[key].label}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="rounded-2xl border border-border/50 bg-muted/10 p-4">
                {selectedView !== "combined" ? (
                  <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                    Balance history is only available for the combined view.
                  </div>
                ) : isLoading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading balance history...
                  </div>
                ) : balanceChartData.length === 0 ? (
                  <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                    No balance history available for this range.
                  </div>
                ) : (
                  <div className="h-56 w-full sm:h-64">
                    <ChartContainer config={balanceChartConfig} className="h-full w-full aspect-auto">
                      <LineChart data={balanceDisplayData}>
                        <CartesianGrid vertical={false} />
                        <XAxis
                          dataKey="timestamp"
                          type="number"
                          domain={["dataMin", "dataMax"]}
                          scale="time"
                          ticks={xTicks}
                          tickFormatter={(value) => formatDateValue(value, tickFormatter)}
                          tickMargin={8}
                        />
                        <YAxis
                          {...(balanceMode === "balance" && logScale
                            ? { scale: "log" as const, allowDataOverflow: true }
                            : {})}
                          tickFormatter={(value) => (balanceMode === "change" ? formatSignedAmount(value) : formatCompactAmount(value))}
                          domain={balanceYDomain}
                          tickMargin={8}
                          width={56}
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              labelFormatter={(value) => formatDateValue(value, tooltipFormatter)}
                              formatter={(value, name) => [
                                balanceMode === "change" ? formatSignedAmount(Number(value)) : formatCompactAmount(Number(value)),
                                balanceChartConfig[name as BalanceSeriesKey]?.label ?? String(name),
                              ]}
                            />
                          }
                        />
                        {/* Zero baseline: in Change mode every series starts here, so
                            the line is the read-off point for accumulation vs selling. */}
                        {balanceMode === "change" && <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />}
                        {renderedBalanceSeries.retail && (
                          <Line
                            dataKey="retail"
                            type="monotone"
                            stroke="var(--color-retail)"
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                          />
                        )}
                        {renderedBalanceSeries.cex && (
                          <Line
                            dataKey="cex"
                            type="monotone"
                            stroke="var(--color-cex)"
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                          />
                        )}
                        {renderedBalanceSeries.dex && (
                          <Line
                            dataKey="dex"
                            type="monotone"
                            stroke="var(--color-dex)"
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                          />
                        )}
                        {balanceChangelogEvents.map((event) => {
                          const eventMs = Date.parse(event.date);
                          if (!Number.isFinite(eventMs)) return null;
                          return (
                            <ReferenceLine
                              key={event.id}
                              x={eventMs}
                              stroke="hsl(var(--muted-foreground))"
                              strokeDasharray="4 4"
                              label={{ value: "Reclassified", position: "insideTopRight", fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                            />
                          );
                        })}
                      </LineChart>
                    </ChartContainer>
                  </div>
                )}
              </div>
            </div>

            </TabsContent>

            {/* Staking balance over time */}
            <TabsContent value="staked" className="mt-4 space-y-4 focus-visible:outline-none">
            <div>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Staked {ticker}</span>
                  {selectedView !== "combined" ? (
                    <span className="text-xs text-muted-foreground">(combined view only)</span>
                  ) : stakingChartData.length === 0 ? null : (
                    <>
                      {stakingStats.latest !== null && (
                        <span>{formatCompactAmount(stakingStats.latest)}</span>
                      )}
                      {(() => {
                        const last = stakingChartData[stakingChartData.length - 1];
                        return last && showStakingSplit ? (
                          <span className="text-sm tabular-nums" data-testid="staked-split">
                            Legacy {formatCompactAmount(last.staking ?? 0)} / v3 {formatCompactAmount(last.stakingV3 ?? 0)}
                          </span>
                        ) : null;
                      })()}
                      {stakingStats.gap.length > 0 && (
                        <ChangeIndicator variant="plain" current={0} previous={0} changelogEvents={stakingStats.gap} className="text-xs" />
                      )}
                      {stakingStats.change !== null && stakingStats.changePct !== null && (
                        <span className={`inline-flex items-center gap-1 ${stakingStats.change >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                          {stakingStats.change >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                          {stakingStats.change >= 0 ? "+" : ""}
                          {formatCompactAmount(Math.abs(stakingStats.change))} ({stakingStats.changePct.toFixed(2)}%)
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-border/50 bg-muted/10 p-4">
                {selectedView !== "combined" ? (
                  <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                    Staking history is only available for the combined view.
                  </div>
                ) : isLoading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading staking history...
                  </div>
                ) : stakingChartData.length === 0 ? (
                  <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                    No staking history for this period.
                  </div>
                ) : (
                  <div className="h-56 w-full sm:h-64">
                    <ChartContainer config={stakingChartConfig} className="h-full w-full aspect-auto">
                      <LineChart data={stakingChartData}>
                        <CartesianGrid vertical={false} />
                        <XAxis
                          dataKey="timestamp"
                          type="number"
                          domain={["dataMin", "dataMax"]}
                          scale="time"
                          ticks={xTicks}
                          tickFormatter={(value) => formatDateValue(value, tickFormatter)}
                          tickMargin={8}
                        />
                        <YAxis
                          tickFormatter={(value) => formatCompactAmount(value)}
                          domain={stakingYDomain}
                          tickMargin={8}
                          width={64}
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              labelFormatter={(value) => formatDateValue(value, tooltipFormatter)}
                              formatter={(value, name) => [
                                formatCompactAmount(Number(value)),
                                stakingChartConfig[name as keyof typeof stakingChartConfig]?.label ?? "Staked",
                              ]}
                            />
                          }
                        />
                        {showStakingSplit && stakingChartData[0] && stakingChartData[0].timestamp <= V3_DEPLOY_MS && stakingChartData.some((p) => p.stakingV3 != null) && (
                          <ReferenceLine
                            x={V3_DEPLOY_MS}
                            stroke="hsl(var(--ha-accent))"
                            strokeDasharray="3 3"
                            label={{ value: "v3 migration", position: "insideTopRight", fill: "hsl(var(--ha-accent))", fontSize: 12, fontWeight: 600 }}
                          />
                        )}
                        <Line
                          dataKey="stakingTotal"
                          type="monotone"
                          stroke="var(--color-stakingTotal)"
                          strokeWidth={2}
                          dot={isolatedDot(stakingChartData, "stakingTotal", "hsl(var(--primary))")}
                        />
                        {showStakingSplit && (
                          <Line
                            dataKey="staking"
                            type="monotone"
                            stroke="var(--color-staking)"
                            strokeWidth={1.5}
                            strokeDasharray="4 3"
                            dot={false}
                            connectNulls
                          />
                        )}
                        {showStakingSplit && (
                          <Line
                            dataKey="stakingV3"
                            type="monotone"
                            stroke="var(--color-stakingV3)"
                            strokeWidth={2}
                            dot={isolatedDot(stakingChartData, "stakingV3", "hsl(var(--ha-accent))")}
                          />
                        )}
                      </LineChart>
                    </ChartContainer>
                  </div>
                )}
              </div>
            </div>

            </TabsContent>
            </SubPanelTabs>

            {/* Provenance applies to every panel, so it stays outside the
                selector rather than repeating in each one. */}
            {data?.updatedAt && (
              <div className="text-xs text-muted-foreground">
                Updated {new Date(data.updatedAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HolderGrowthWidget;
