import { useMemo } from "react";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompact } from "@/lib/format";
import { useChartIntro } from "@/hooks/useMotion";
import { CHART_DRAW_MS } from "@/lib/motion";
import { computeBreakAwareDomain } from "@/lib/chartDomain";
import { breakNotesByRow, insertBreakSpacers, limitedHistoryCount, type SeriesBreak } from "@/lib/seriesBreaks";

/** Dense defaults: 12px ticks, hairline grid, no legend (the panel header names series). */
const TICK = { fill: "hsl(var(--muted-foreground))", fontSize: 12 };
const MARGIN = { top: 6, right: 8, bottom: 0, left: 0 };
const dateTick = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const dateFull = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDate = (v: unknown, f = dateTick) => {
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? f.format(new Date(n)) : "";
};

export type SeriesDef = {
  key: string;
  label: string;
  color: string;
  /** Draw straight across missing values (default). Turn off for a series
   *  whose nulls mean "unknown", so the line doesn't invent a history. */
  connectNulls?: boolean;
  dashed?: boolean;
};

/** With connectNulls off, a value with no measured neighbour draws no line
 *  at all; give those isolated points a dot so they stay visible. */
const isolatedDot = (data: TimeChartProps["data"], key: string, color: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (props: any) => {
    const i = props?.index as number;
    const has = (j: number) => data[j] != null && data[j][key] != null;
    const show = has(i) && !has(i - 1) && !has(i + 1) && Number.isFinite(props?.cx) && Number.isFinite(props?.cy);
    return show ? (
      <circle key={`${key}-${i}`} cx={props.cx} cy={props.cy} r={3} fill={color} stroke="hsl(var(--background))" strokeWidth={1} />
    ) : (
      <g key={`${key}-${i}`} />
    );
  };
/** A dated annotation drawn as a dashed vertical rule (e.g. a reclassification). */
export type ChartMarker = { t: number; label: string; description: string };

const TooltipBox = ({
  active,
  payload,
  label,
  series,
  format,
  breakNotes,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number }>;
  label?: unknown;
  series: SeriesDef[];
  format: (n: number) => string;
  breakNotes?: Map<number, string>;
}) => {
  if (!active || !payload?.length) return null;
  const breakNote = typeof label === "number" ? breakNotes?.get(label) : undefined;
  return (
    <div className="rounded-md border border-border bg-popover px-2 py-1.5 text-sm text-popover-foreground shadow-md">
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
      {breakNote && <div className="mt-0.5 max-w-[16rem] text-xs text-warning">{breakNote}</div>}
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
  markers?: ChartMarker[];
  /** Declared methodology breaks (see `getSeriesBreaks`): the line is split
   *  there, labelled, and the jump is kept out of the y-domain. */
  breaks?: SeriesBreak[];
  /** Series key to emphasise (legend hover/focus); the others fade. */
  highlight?: string | null;
};

export const TimeChart = ({
  data,
  series,
  format = (n) => formatCompact(n),
  kind = "line",
  label,
  markers = [],
  breaks = [],
  highlight = null,
}: TimeChartProps) => {
  const Chart = kind === "area" ? AreaChart : LineChart;
  // Draw in on first mount only; range/chain changes then update instantly.
  const anim = useChartIntro();
  const fade = (key: string) => highlight != null && highlight !== key;
  // A break near the left edge has no room for its label on the left of the rule.
  const breakNearStart = (t: number) => {
    const ts = data.map((d) => Number(d.t)).filter(Number.isFinite);
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    return hi > lo && (t - lo) / (hi - lo) < 0.3;
  };
  const labelled = useMemo(() => {
    const ts = data.map((d) => Number(d.t)).filter(Number.isFinite);
    const span = ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
    const gap = span * 0.12;
    const sorted = markers.map((m) => m.t);
    // A break's label wins: reclass labels yield to a break within `gap`.
    const reclass = markers.map(
      (m) => !sorted.some((t) => t > m.t && t - m.t < gap) && !breaks.some((b) => Math.abs(b.t - m.t) < gap),
    );
    const breakTimes = breaks.map((b) => b.t);
    const breakLabels = breaks.map((b) => !breakTimes.some((t) => t > b.t && t - b.t < gap));
    return { reclass, breakLabels };
  }, [data, markers, breaks]);
  const keys = useMemo(() => series.map((s) => s.key), [series]);
  const breakTs = useMemo(() => breaks.map((b) => b.t), [breaks]);
  // A break splits every series, so nulls must not be bridged while one is drawn.
  const split = breaks.length > 0;
  const chartData = useMemo(() => insertBreakSpacers(data, breakTs, "t", keys) as typeof data, [data, breakTs, keys]);
  const domain = useMemo(
    () => (split ? computeBreakAwareDomain(data, keys, breakTs, "t") : (["auto", "auto"] as ["auto", "auto"])),
    [split, data, keys, breakTs],
  );
  const breakNotes = useMemo(() => breakNotesByRow(data.map((d) => d.t), breaks), [data, breaks]);
  // Too few points to call a curve: straight segments, visible dots, a note.
  const limited = limitedHistoryCount(data, keys);
  const curve = limited != null ? "linear" : "monotone";
  const pointDot = (key: string, color: string) =>
    limited != null
      ? { r: 2.5, fill: color, stroke: "hsl(var(--background))", strokeWidth: 1 }
      : split || (series.find((x) => x.key === key)?.connectNulls === false)
        ? isolatedDot(chartData, key, color)
        : false;
  const allMarkers = [...markers.map((m) => m.description), ...breaks.map((b) => b.description)];
  const fullLabel = allMarkers.length
    ? `${label} ${[
        ...markers.map((m) => `${m.description} on ${fmtDate(m.t, dateFull)}.`),
        ...breaks.map((b) => `${b.description} on ${fmtDate(b.t, dateFull)}.`),
      ].join(" ")}`
    : limited != null
      ? `${label} Limited history (${limited} days).`
      : label;
  return (
    <div role="img" aria-label={fullLabel} className="relative h-full w-full" data-markers={markers.length || undefined} data-breaks={breaks.length || undefined}>
      {limited != null && (
        <p className="pointer-events-none absolute bottom-7 right-3 z-10 text-xs text-muted-foreground" data-testid="limited-history">
          Limited history ({limited} {limited === 1 ? "day" : "days"})
        </p>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={chartData} margin={MARGIN}>
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
            width={48}
            domain={domain}
            allowDataOverflow={split}
            tickFormatter={(v: number) => formatCompact(v, 1)}
          />
          <Tooltip content={<TooltipBox series={series} format={format} breakNotes={breakNotes} />} />
          {breaks.map((b, i) => (
            <ReferenceLine
              key={`break-${b.t}`}
              x={b.t}
              stroke="hsl(var(--ha-warning))"
              strokeDasharray="2 3"
              strokeWidth={1}
              label={
                labelled.breakLabels[i]
                  ? { value: b.label, position: breakNearStart(b.t) ? "insideTopLeft" : "insideTopRight", fill: "hsl(var(--ha-warning))", fontSize: 12, fontWeight: 600 }
                  : undefined
              }
            />
          ))}
          {markers.map((m, i) => (
            <ReferenceLine
              key={`${m.t}-${m.label}`}
              x={m.t}
              ifOverflow="extendDomain"
              stroke="hsl(var(--ha-accent))"
              strokeDasharray="3 3"
              strokeWidth={1}
              // Close-together markers share one label (on the latest) so
              // their text doesn't overprint.
              label={
                labelled.reclass[i]
                  ? { value: m.label, position: "insideTopRight", fill: "hsl(var(--ha-accent))", fontSize: 12, fontWeight: 600 }
                  : undefined
              }
            />
          ))}
          {series.map((s) =>
            kind === "area" ? (
              <Area
                key={s.key}
                dataKey={s.key}
                type={curve}
                stroke={s.color}
                fill={s.color}
                fillOpacity={fade(s.key) ? 0.04 : 0.15}
                strokeOpacity={fade(s.key) ? 0.25 : 1}
                strokeWidth={highlight === s.key ? 2.25 : 1.5}
                strokeDasharray={s.dashed ? "4 3" : undefined}
                dot={pointDot(s.key, s.color)}
                isAnimationActive={anim} animationDuration={CHART_DRAW_MS} animationEasing="ease-out"
                connectNulls={split ? false : (s.connectNulls ?? true)}
              />
            ) : (
              <Line
                key={s.key}
                dataKey={s.key}
                type={curve}
                stroke={s.color}
                strokeOpacity={fade(s.key) ? 0.25 : 1}
                strokeWidth={highlight === s.key ? 2.25 : 1.5}
                strokeDasharray={s.dashed ? "4 3" : undefined}
                dot={pointDot(s.key, s.color)}
                isAnimationActive={anim} animationDuration={CHART_DRAW_MS} animationEasing="ease-out"
                connectNulls={split ? false : (s.connectNulls ?? true)}
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
export const SignedBars = ({ data, format = (n) => formatCompact(n), label, seriesLabel }: SignedBarsProps) => {
  const anim = useChartIntro();
  return (
    <div role="img" aria-label={label} className="h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={MARGIN}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <XAxis dataKey="t" tickFormatter={(v) => fmtDate(v)} tick={TICK} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => formatCompact(v, 1)} />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            content={<TooltipBox series={[{ key: "value", label: seriesLabel, color: "hsl(var(--primary))" }]} format={format} />}
          />
          <Bar dataKey="value" isAnimationActive={anim} animationDuration={CHART_DRAW_MS} animationEasing="ease-out">
            {data.map((d) => (
              <Cell key={d.t} fill={d.value >= 0 ? "hsl(var(--ha-positive))" : "hsl(var(--ha-negative))"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

type CategoryBarsProps = {
  /** `name` is the axis label; `full` (if given) is the tooltip's. */
  data: Array<{ name: string; full?: string; value: number; highlight?: boolean }>;
  format?: (n: number) => string;
  label: string;
};

/** Vertical category bars for distributions (buckets on X). */
export const CategoryBars = ({ data, format = (n) => formatCompact(n), label }: CategoryBarsProps) => {
  const anim = useChartIntro();
  const { ticker } = useProjectCopy();
  return (
    <div role="img" aria-label={label} className="h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={MARGIN}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => formatCompact(v, 1)} />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            formatter={(v: number) => [format(v), "Wallets"]}
            labelFormatter={(name: string) => {
              const row = data.find((d) => d.name === name);
              return row?.full ? `${row.full} ${ticker}` : name;
            }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              fontSize: 14,
              color: "hsl(var(--popover-foreground))",
            }}
            labelStyle={{ color: "hsl(var(--popover-foreground))" }}
            itemStyle={{ color: "hsl(var(--popover-foreground))" }}
          />
          <Bar dataKey="value" radius={[2, 2, 0, 0]} isAnimationActive={anim} animationDuration={CHART_DRAW_MS} animationEasing="ease-out">
            {data.map((d) => (
              <Cell key={d.name} fill={d.highlight ? "hsl(var(--ha-accent))" : "hsl(var(--primary))"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
