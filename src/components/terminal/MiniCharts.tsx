import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompact } from "@/lib/format";

/** Dense defaults: 10px ticks, hairline grid, no legend (the panel header names series). */
const TICK = { fill: "hsl(var(--muted-foreground))", fontSize: 10 };
const MARGIN = { top: 6, right: 8, bottom: 0, left: 0 };
const dateTick = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dateFull = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtDate = (v: unknown, f = dateTick) => {
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? f.format(new Date(n)) : "";
};

export type SeriesDef = { key: string; label: string; color: string };

const TooltipBox = ({
  active,
  payload,
  label,
  series,
  format,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number }>;
  label?: unknown;
  series: SeriesDef[];
  format: (n: number) => string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] text-popover-foreground shadow-md">
      <div className="mb-0.5 font-medium">{fmtDate(label, dateFull)}</div>
      {payload.map((p) => {
        const s = series.find((x) => x.key === p.dataKey);
        if (!s || p.value == null) return null;
        return (
          <div key={s.key} className="flex items-center gap-1.5 tabular-nums">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="ml-auto pl-3 font-semibold">{format(p.value)}</span>
          </div>
        );
      })}
    </div>
  );
};

type TimeChartProps = {
  data: Array<Record<string, number | null> & { t: number }>;
  series: SeriesDef[];
  format?: (n: number) => string;
  kind?: "line" | "area";
  /** Screen-reader summary; the SVG itself is presentational. */
  label: string;
};

export const TimeChart = ({ data, series, format = (n) => formatCompact(n), kind = "line", label }: TimeChartProps) => {
  const Chart = kind === "area" ? AreaChart : LineChart;
  return (
    <div role="img" aria-label={label} className="h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={data} margin={MARGIN}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => fmtDate(v)}
            tick={TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={TICK}
            tickLine={false}
            axisLine={false}
            width={44}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => formatCompact(v, 1)}
          />
          <Tooltip content={<TooltipBox series={series} format={format} />} />
          {series.map((s) =>
            kind === "area" ? (
              <Area
                key={s.key}
                dataKey={s.key}
                type="monotone"
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ) : (
              <Line
                key={s.key}
                dataKey={s.key}
                type="monotone"
                stroke={s.color}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ),
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
};

type SignedBarsProps = {
  data: Array<{ t: number; value: number }>;
  format?: (n: number) => string;
  label: string;
  seriesLabel: string;
};

/** Daily signed bars (green = positive, red = negative). */
export const SignedBars = ({ data, format = (n) => formatCompact(n), label, seriesLabel }: SignedBarsProps) => (
  <div role="img" aria-label={label} className="h-full w-full">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
        <XAxis dataKey="t" tickFormatter={(v) => fmtDate(v)} tick={TICK} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => formatCompact(v, 1)} />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))" }}
          content={<TooltipBox series={[{ key: "value", label: seriesLabel, color: "hsl(var(--primary))" }]} format={format} />}
        />
        <Bar dataKey="value" isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.t} fill={d.value >= 0 ? "hsl(var(--ha-positive))" : "hsl(var(--ha-negative))"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>
);

type CategoryBarsProps = {
  data: Array<{ name: string; value: number; highlight?: boolean }>;
  format?: (n: number) => string;
  label: string;
};

/** Vertical category bars for distributions (buckets on X). */
export const CategoryBars = ({ data, format = (n) => formatCompact(n), label }: CategoryBarsProps) => (
  <div role="img" aria-label={label} className="h-full w-full">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
        <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={false} interval={0} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} tickFormatter={(v: number) => formatCompact(v, 0)} />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))" }}
          formatter={(v: number) => [format(v), "Wallets"]}
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            fontSize: 11,
            color: "hsl(var(--popover-foreground))",
          }}
          labelStyle={{ color: "hsl(var(--popover-foreground))" }}
          itemStyle={{ color: "hsl(var(--popover-foreground))" }}
        />
        <Bar dataKey="value" radius={[2, 2, 0, 0]} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.highlight ? "hsl(var(--ha-accent))" : "hsl(var(--primary))"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>
);
