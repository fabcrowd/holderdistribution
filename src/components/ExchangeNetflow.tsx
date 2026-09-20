import { useMemo } from "react";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { InfoTooltip } from "@/components/InfoTooltip";

type ExchangeNetflowProps = {
  rangeDays: number;
};

const formatCompactTEL = (value: number) => {
  const a = Math.abs(value);
  if (a >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return `${Math.round(value)}`;
};

const chartConfig = { net: { label: "Net flow", color: "hsl(var(--primary))" } };

const INFO =
  "Measured directly from TEL Transfer logs: coins actually deposited to (inflow) or withdrawn from (outflow) known exchange wallets each day.\n\nA deposit is not a sale — it's TEL moving toward the market and available to be sold; a withdrawal is TEL leaving the market for self-custody or staking. Trading itself happens off-chain, so this shows supply positioning, not realized buys/sells.";

export const ExchangeNetflow = ({ rangeDays }: ExchangeNetflowProps) => {
  const { data: entries } = useExchangeFlow();

  const view = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    const latestTs = Date.parse(entries[entries.length - 1].date);
    const cutoff = latestTs - rangeDays * 86400000;
    const inRange = entries.filter((e) => Date.parse(e.date) >= cutoff);
    if (inRange.length === 0) return null;
    const totalIn = inRange.reduce((s, e) => s + (e.in ?? 0), 0);
    const totalOut = inRange.reduce((s, e) => s + (e.out ?? 0), 0);
    const series = inRange.map((e) => ({ timestamp: Date.parse(e.date), net: (e.in ?? 0) - (e.out ?? 0) }));
    return { totalIn, totalOut, net: totalIn - totalOut, series };
  }, [entries, rangeDays]);

  if (!view) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
          Exchange Netflow — measured deposits &amp; withdrawals
        </div>
        <InfoTooltip text={INFO} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="premium-surface-card p-4 text-center">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Deposits (in)</div>
          <div className="text-xl font-bold text-foreground">{formatCompactTEL(view.totalIn)} TEL</div>
        </div>
        <div className="premium-surface-card p-4 text-center">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Withdrawals (out)</div>
          <div className="text-xl font-bold text-foreground">{formatCompactTEL(view.totalOut)} TEL</div>
        </div>
        <div className="premium-surface-card p-4 text-center">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">Net</div>
          <div className="text-xl font-bold text-foreground">
            {view.net >= 0 ? "+" : "−"}{formatCompactTEL(Math.abs(view.net))} TEL
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {view.net >= 0 ? "toward exchanges" : "leaving exchanges"}
          </div>
        </div>
      </div>
      <div className="premium-surface-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-3 text-center">
          Daily net flow (▲ toward exchanges · ▼ leaving)
        </p>
        <ChartContainer config={chartConfig} className="h-[220px] w-full aspect-auto">
          <BarChart data={view.series} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid vertical={false} className="stroke-border/40" />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickMargin={8}
            />
            <YAxis tickFormatter={(v) => formatCompactTEL(v)} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} width={52} />
            <ReferenceLine y={0} className="stroke-border" />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, p) => {
                    const ts = p?.[0]?.payload?.timestamp;
                    return ts ? new Date(ts).toLocaleDateString() : "";
                  }}
                  formatter={(value) => [`${Number(value) >= 0 ? "+" : "−"}${formatCompactTEL(Math.abs(Number(value)))} TEL`, "Net flow"]}
                />
              }
            />
            <Bar dataKey="net" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {view.series.map((d) => (
                <Cell key={d.timestamp} fill={d.net >= 0 ? "hsl(0 72% 55%)" : "hsl(142 71% 45%)"} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </div>
    </div>
  );
};
