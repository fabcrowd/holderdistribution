import { useMemo } from "react";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import "@/lib/rechartsMotion";
import { barSizing, computeYAxisFromRows, distinctTickFormatter } from "@/lib/chartAxes";
import { COMPACT_FLOW_ROW, formatCompact } from "@/lib/format";
import { CHART_TICK } from "@/lib/terminalLayout";
import { ZoomFrame } from "@/components/chart/ZoomFrame";
import { useChartZoom } from "@/hooks/useChartZoom";
import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { feedAsOf } from "@/hooks/useFeedAsOf";
import { InfoTooltip } from "@/components/InfoTooltip";
import { useProject } from "@/hooks/useProject";
import { PARTIAL_DAY_LABEL, settledEntries } from "@/lib/flowFeeds";
import { flowEmptyMessage } from "@/lib/flowEmptyState";
import { flowOutOfRangeMessage, flowWindow, staleFeedNote } from "@/lib/flowWindow";
import { settledEndMs } from "@/lib/settledEnd";

type ExchangeNetflowProps = {
  rangeDays: number;
};

const formatCompactAmount = (value: number) => formatCompact(value, COMPACT_FLOW_ROW);

const NO_ROWS: Array<{ timestamp: number; net: number }> = [];

const chartConfig = { net: { label: "Net flow", color: "hsl(var(--primary))" } };

const INFO_TEMPLATE =
  "Measured directly from {ticker} Transfer logs: coins actually deposited to (inflow) or withdrawn from (outflow) known exchange wallets each day.\n\nA deposit is not a sale — it's {ticker} moving toward the market and available to be sold; a withdrawal is {ticker} leaving the market for self-custody or staking. Trading itself happens off-chain, so this shows supply positioning, not realized buys/sells.";

export const ExchangeNetflow = ({ rangeDays }: ExchangeNetflowProps) => {
  const { data: entries, isPending, isError } = useExchangeFlow();
  const asOf = feedAsOf(entries);
  const { ticker, t } = useProjectCopy();
  const { project } = useProject();

  const view = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    // Today's hours-so-far are not totalled beside full days; they only show
    // (labelled) when no finished day exists yet.
    const settled = settledEntries(entries);
    const rows = settled.length > 0 ? settled : entries;
    const partialOnly = settled.length === 0;
    // Window ends today (UTC), not at the feed's last row: a stale feed must
    // not be summed as if it were the selected range.
    const { rows: inRange, lastMs, stale } = flowWindow(rows, rangeDays, undefined, partialOnly ? undefined : settledEndMs({ asOf }, undefined, Date.parse(settled[settled.length - 1].date)));
    if (inRange.length === 0) return { kind: "outOfRange" as const, outOfRangeLastMs: lastMs as number };
    const totalIn = inRange.reduce((s, e) => s + (e.in ?? 0), 0);
    const totalOut = inRange.reduce((s, e) => s + (e.out ?? 0), 0);
    const series = inRange.map((e) => ({ timestamp: Date.parse(e.date), net: (e.in ?? 0) - (e.out ?? 0) }));
    const spansYears = new Date(series[0].timestamp).getUTCFullYear() !== new Date(series[series.length - 1].timestamp).getUTCFullYear();
    return { kind: "ok" as const, totalIn, totalOut, net: totalIn - totalOut, series, partialOnly, excludesToday: !partialOnly && settled.length < entries.length, staleLastMs: stale ? (lastMs as number) : null, spansYears };
  }, [entries, rangeDays, asOf]);

  const zoom = useChartZoom(view?.kind === "ok" ? view.series : NO_ROWS, (d) => d.timestamp);
  // Signed daily bars: zero baseline fitted to the visible days only.
  const netScale = computeYAxisFromRows(zoom.rows, ["net"], { kind: "bar" });
  const netFmt = distinctTickFormatter(netScale.ticks, formatCompact);
  const sizing = barSizing(zoom.rows.length);

  // Still fetching, or a real failure (5xx): the terminal panel owns the
  // skeleton and the retry. A settled empty feed is the empty state.
  if (isPending || isError) return null;
  if (view?.kind !== "ok") {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground" data-testid="exchange-flow-empty">
        {view ? flowOutOfRangeMessage(view.outOfRangeLastMs) : flowEmptyMessage(project, "exchange")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <div className="text-xs text-muted-foreground font-semibold">
          Exchange Netflow — measured deposits &amp; withdrawals
        </div>
        <InfoTooltip text={t(INFO_TEMPLATE)} />
        {view.staleLastMs != null && (
          <span className="text-xs font-medium text-warning" data-testid="exchange-flow-stale">
            ({staleFeedNote(view.staleLastMs)})
          </span>
        )}
        {(view.partialOnly || view.excludesToday) && (
          <span className="text-xs text-muted-foreground" data-testid="exchange-flow-partial">
            {view.partialOnly ? `(${PARTIAL_DAY_LABEL})` : "(finished days only; today is still in progress)"}
          </span>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="premium-surface-card p-4 text-center">
          <div className="text-xs text-muted-foreground font-semibold mb-1">Deposits (in)</div>
          <div className="text-xl font-bold text-foreground">{formatCompactAmount(view.totalIn)} {ticker}</div>
        </div>
        <div className="premium-surface-card p-4 text-center">
          <div className="text-xs text-muted-foreground font-semibold mb-1">Withdrawals (out)</div>
          <div className="text-xl font-bold text-foreground">{formatCompactAmount(view.totalOut)} {ticker}</div>
        </div>
        <div className="premium-surface-card p-4 text-center">
          <div className="text-xs text-muted-foreground font-semibold mb-1">Net</div>
          <div className="text-xl font-bold text-foreground">
            {view.net >= 0 ? "+" : "−"}{formatCompactAmount(Math.abs(view.net))} {ticker}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {view.net >= 0 ? "toward exchanges" : "leaving exchanges"}
          </div>
        </div>
      </div>
      <div className="premium-surface-card p-4">
        <p className="text-xs text-muted-foreground font-semibold mb-3 text-center">
          Daily net flow (▲ toward exchanges · ▼ leaving)
        </p>
        <ZoomFrame zoom={zoom} className="h-[220px] w-full">
        <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
          <BarChart data={zoom.rows} margin={{ top: 8, right: 8, bottom: 4, left: 8 }} barCategoryGap={sizing.barCategoryGap} accessibilityLayer>
            <CartesianGrid vertical={false} className="stroke-border/40" />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(view.spansYears ? { year: "2-digit" as const } : {}), timeZone: "UTC" })}
              tick={CHART_TICK}
              tickMargin={8}
            />
            <YAxis tickFormatter={netFmt} tick={CHART_TICK} width={52} domain={netScale.domain} ticks={netScale.ticks} />
            <ReferenceLine y={0} className="stroke-border" />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, p) => {
                    const ts = p?.[0]?.payload?.timestamp;
                    return ts ? new Date(ts).toLocaleDateString(undefined, { timeZone: "UTC" }) : "";
                  }}
                  formatter={(value) => [`${Number(value) >= 0 ? "+" : "−"}${formatCompactAmount(Math.abs(Number(value)))} ${ticker}`, "Net flow"]}
                />
              }
            />
            <Bar dataKey="net" radius={[2, 2, 0, 0]} maxBarSize={sizing.maxBarSize} minPointSize={sizing.minPointSize} isAnimationActive={false}>
              {zoom.rows.map((d) => (
                <Cell key={d.timestamp} fill={d.net >= 0 ? "hsl(0 72% 55%)" : "hsl(142 71% 45%)"} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
        </ZoomFrame>
      </div>
    </div>
  );
};
