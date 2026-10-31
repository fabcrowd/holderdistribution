import { useId, useMemo, type ReactNode } from "react";
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
import { computeBreakAwareDomain, maskExcludedSegments } from "@/lib/chartDomain";
import {
  assignAxes,
  barSizing,
  computeYAxis,
  computeYAxisFromRows,
  distinctTickFormatter,
  hasRightAxis,
  keysOnAxis,
  yAxisWidthFor,
  type AxisSide,
  type YAxisScale,
} from "@/lib/chartAxes";
import { AxisBaselineNote } from "@/components/chart/AxisBaselineNote";
import { CHART_HEIGHT, CHART_TICK, PANEL_PADDING_PX } from "@/lib/terminalLayout";
import { ZoomFrame } from "@/components/chart/ZoomFrame";
import { ChartLegend, type LegendItem } from "@/components/chart/ChartLegend";
import { useChartZoom, type ChartZoom, type YRanges } from "@/hooks/useChartZoom";
import { useSeriesToggle } from "@/hooks/useSeriesToggle";
import { breakTooltip, insertBreakSpacers, limitedHistoryCount, type SeriesBreak } from "@/lib/seriesBreaks";
import { groupMarkers, markerCollapseGap, markerNotesByRow, type ChartNote, type MarkerGroup } from "@/lib/chartMarkers";
import { markerLines } from "@/components/chart/ChartMarkers";
import { ChartDataTable, type ChartTableColumn } from "@/components/chart/ChartDataTable";
import { CHART_FOCUS_RING } from "@/components/ui/chart";
import { defaultTableTitle, rowsWithValues } from "@/lib/chartTable";

/** Dense defaults: shared 12px ticks, hairline grid. */
const TICK = CHART_TICK;
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
  /** Put this series on a secondary y-axis (right) with its own scale, so a
   *  series of a different size or unit isn't flattened against the main one. */
  axis?: AxisSide;
  /** Unit label ("wallets", "TEL"). Series in different units never share an axis. */
  unit?: string;
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
/** Annotations whose time falls inside the zoom window (all of them when unzoomed). */
const inZoomWindow = <M extends { t: number }>(items: M[], win: readonly [number, number] | null): M[] =>
  win ? items.filter((m) => m.t >= win[0] && m.t <= win[1]) : items;

/** Table columns for a time chart: the date, then one column per drawn series in its tooltip format. */
const timeTableColumns = (series: readonly Pick<SeriesDef, "key" | "label">[], format: (n: number) => string, labelOf: (s: Pick<SeriesDef, "key" | "label">) => string): ChartTableColumn[] => [
  { key: "t", label: "Date", format: (v) => fmtDate(v, dateFull) },
  ...series.map((s) => ({
    key: s.key,
    label: labelOf(s),
    align: "right" as const,
    format: (v: unknown) => (typeof v === "number" ? format(v) : ""),
  })),
];

/** A dated annotation drawn as a dashed vertical rule (e.g. a reclassification). */
export type ChartMarker = { t: number; label: string; description: string };

const TooltipBox = ({
  active,
  payload,
  label,
  series,
  format,
  notes,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number }>;
  label?: unknown;
  series: SeriesDef[];
  format: (n: number) => string;
  notes?: ReadonlyMap<number, readonly string[]>;
}) => {
  if (!active || !payload?.length) return null;
  const rowNotes = typeof label === "number" ? notes?.get(label) : undefined;
  return (
    <div className="max-w-[12rem] rounded border border-border bg-popover px-1.5 py-1 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{fmtDate(label, dateFull)}</div>
      {payload.map((p) => {
        const s = series.find((x) => x.key === p.dataKey);
        if (!s || p.value == null) return null;
        return (
          <div key={s.key} className="flex items-center gap-1 tabular-nums">
            <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
            <span className="truncate text-muted-foreground">{s.label}</span>
            <span className="ml-auto pl-2 font-semibold">{format(p.value)}</span>
          </div>
        );
      })}
      {rowNotes?.map((n) => (
        <div key={n} className="mt-0.5 text-warning">
          {n}
        </div>
      ))}
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
  /** "View data as table" disclosure under the plot (default on). */
  table?: boolean;
  /** Short title for the data sheet; defaults to the series labels. */
  tableTitle?: string;
};

type Row = TimeChartProps["data"][number];

/** Latest non-null value of a series: the figure a stacked plot's title row shows. */
const latestValue = (rows: readonly Row[], key: string): number | null => {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = rows[i][key];
    if (value != null) return value;
  }
  return null;
};

/** What a plot draws for one zoom window: masked rows, break spacers and grouped markers. */
type TimeModel = {
  chartData: Row[];
  breakTs: number[];
  split: boolean;
  markerGroups: MarkerGroup<ChartNote>[];
  markerNotes: ReturnType<typeof markerNotesByRow>;
};

const buildTimeModel = (rows: Row[], keys: string[], markers: ChartMarker[], breaks: SeriesBreak[]): TimeModel => {
  const breakTs = breaks.map((b) => b.t);
  const times = rows.map((d) => Number(d.t));
  // Breaks and reclass markers share one marker per collapsed group; wording goes to the tooltip.
  const notes: ChartNote[] = [
    ...breaks.map((b) => ({ t: b.t, text: b.description, tone: "warning" as const, tooltip: breakTooltip(b) })),
    ...markers.map((m) => ({ t: m.t, text: m.description, tone: "accent" as const })),
  ];
  const markerGroups = groupMarkers(notes, markerCollapseGap(times));
  return {
    breakTs,
    // A break splits every series, so nulls must not be bridged while one is drawn.
    split: breaks.length > 0,
    chartData: insertBreakSpacers(maskExcludedSegments(rows, keys, breakTs, "t"), breakTs, "t", keys) as Row[],
    markerGroups,
    markerNotes: markerNotesByRow(times, markerGroups),
  };
};

/** Auto-fit range for one side over the rows and series it draws. A declared break's jump stays out of the domain. */
const autoScale = (rows: Row[], series: SeriesDef[], side: AxisSide, breakTs: number[]): YAxisScale => {
  const sideKeys = keysOnAxis(series, side);
  if (!breakTs.length) return computeYAxisFromRows(rows, sideKeys, { kind: "line" });
  const [lo, hi] = computeBreakAwareDomain(rows, sideKeys, breakTs, "t", { allowNegative: true });
  return typeof lo === "number" && typeof hi === "number" ? computeYAxis([lo, hi], { kind: "line" }) : computeYAxis([], { kind: "line" });
};

/**
 * Each side's scale over the visible rows and series. Auto-fit scales are the
 * drag base; the zoom hook swaps in a manual range once the user drags an axis.
 */
const sideScales = (rows: Row[], series: SeriesDef[], breakTs: number[], zoom: ChartZoom<Row>) => {
  const autoLeft = autoScale(rows, series, "left", breakTs);
  const autoRight = hasRightAxis(series) ? autoScale(rows, series, "right", breakTs) : undefined;
  return {
    auto: { left: autoLeft, right: autoRight },
    scales: { left: zoom.yScale("left", autoLeft), right: autoRight && zoom.yScale("right", autoRight) },
  };
};

/** The full-range rows a plot draws (breaks and masked segments applied), minus rows with no measured value. */
const tableRowsFor = (rows: Row[], keys: string[], breaks: SeriesBreak[]): Row[] =>
  rowsWithValues(buildTimeModel(rows, keys, [], breaks).chartData, keys);

const summarizeLabel = (label: string, markers: ChartMarker[], breaks: SeriesBreak[], limited: number | null): string => {
  const notes = [
    ...markers.map((m) => `${m.description} on ${fmtDate(m.t, dateFull)}.`),
    ...breaks.map((b) => `${b.description} on ${fmtDate(b.t, dateFull)}.`),
  ];
  if (notes.length) return `${label} ${notes.join(" ")}`;
  return limited != null ? `${label} Limited history (${limited} days).` : label;
};

type PlotProps = {
  model: TimeModel;
  series: SeriesDef[];
  scales: { left: YAxisScale; right: YAxisScale | undefined };
  yRanges: YRanges;
  format: (n: number) => string;
  kind: "line" | "area";
  highlight: string | null;
  /** Points available when the history is short (see `limitedHistoryCount`). */
  limited: number | null;
  /** Only the bottom plot of a stack labels the shared x-axis. */
  xTicks: boolean;
  syncId?: string;
  /** False on all but one plot of a stack, so the stack is a single Tab stop. */
  tabStop?: boolean;
};

/** The Recharts plot for one zoom window. Reads the axis scales it is given; it does not compute them. */
const TimeChartPlot = ({ model, series, scales, yRanges, format, kind, highlight, limited, xTicks, syncId, tabStop = true }: PlotProps) => {
  const Chart = kind === "area" ? AreaChart : LineChart;
  // Draw in on first mount only; range/chain changes then update instantly.
  const anim = useChartIntro();
  const fade = (key: string) => highlight != null && highlight !== key;
  const axes = useMemo(() => assignAxes(series), [series]);
  const leftFmt = useMemo(() => distinctTickFormatter(scales.left.ticks, formatCompact), [scales.left]);
  const rightFmt = useMemo(() => (scales.right ? distinctTickFormatter(scales.right.ticks, formatCompact) : undefined), [scales.right]);
  // Size each gutter from its longest label: tight domains print 3 decimals ("46.026B").
  const leftWidth = yAxisWidthFor(scales.left.ticks.map(leftFmt), TICK.fontSize);
  const rightWidth = yAxisWidthFor(scales.right && rightFmt ? scales.right.ticks.map(rightFmt) : [], TICK.fontSize);
  const { chartData, split } = model;
  const curve = limited != null ? "linear" : "monotone";
  const pointDot = (key: string, color: string) =>
    limited != null
      ? { r: 2.5, fill: color, stroke: "hsl(var(--background))", strokeWidth: 1 }
      : split || (series.find((x) => x.key === key)?.connectNulls === false)
        ? isolatedDot(chartData, key, color)
        : false;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <Chart data={chartData} margin={MARGIN} syncId={syncId} accessibilityLayer tabIndex={tabStop ? 0 : -1}>
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
          tickMargin={6}
          height={34}
          hide={!xTicks}
        />
        <YAxis
          yAxisId="left"
          tick={TICK}
          tickLine={false}
          axisLine={false}
          width={leftWidth}
          domain={scales.left.domain}
          ticks={scales.left.ticks}
          allowDataOverflow={split || yRanges.left != null}
          tickFormatter={leftFmt}
        />
        {scales.right && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ ...TICK, fill: series.find((s) => axes[s.key] === "right")?.color ?? TICK.fill }}
            tickLine={false}
            axisLine={false}
            width={rightWidth}
            domain={scales.right.domain}
            ticks={scales.right.ticks}
            allowDataOverflow={split || yRanges.right != null}
            tickFormatter={rightFmt}
          />
        )}
        <Tooltip position={{ y: 0 }} content={<TooltipBox series={series} format={format} notes={model.markerNotes} />} />
        {markerLines(model.markerGroups, "mk", "left")}
        {series.map((s) =>
          kind === "area" ? (
            <Area
              key={s.key}
              dataKey={s.key}
              yAxisId={axes[s.key]}
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
              yAxisId={axes[s.key]}
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
  );
};

export const TimeChart = ({
  data: allData,
  series: allSeries,
  format = (n) => formatCompact(n),
  kind = "line",
  label,
  markers: allMarkers = [],
  breaks: allBreaks = [],
  highlight = null,
  table = true,
  tableTitle,
}: TimeChartProps) => {
  const toggled = useSeriesToggle(useMemo(() => allSeries.map((s) => s.key), [allSeries]));
  const series = useMemo(() => allSeries.filter((s) => !toggled.hidden.has(s.key)), [allSeries, toggled.hidden]);
  const zoom = useChartZoom(allData, (d) => Number(d.t));
  const data = zoom.rows;
  const markers = useMemo(() => inZoomWindow(allMarkers, zoom.window), [allMarkers, zoom.window]);
  const breaks = useMemo(() => inZoomWindow(allBreaks, zoom.window), [allBreaks, zoom.window]);
  const keys = useMemo(() => series.map((s) => s.key), [series]);
  const model = useMemo(() => buildTimeModel(data, keys, markers, breaks), [data, keys, markers, breaks]);
  const tableRows = useMemo(() => tableRowsFor(allData, keys, allBreaks), [allData, keys, allBreaks]);
  const { auto, scales } = sideScales(data, series, model.breakTs, zoom);
  // Too few points to call a curve: straight segments, visible dots, a note.
  const limited = limitedHistoryCount(allData, keys);
  const fullLabel = summarizeLabel(label, allMarkers, allBreaks, limited);
  const dualAxes = assignAxes(allSeries);
  const dualAll = hasRightAxis(allSeries);
  const legendItems: LegendItem[] = allSeries.map((s) => ({
    key: s.key,
    label: s.label,
    color: s.color,
    dashed: s.dashed,
    note: dualAll ? (dualAxes[s.key] === "right" ? "right axis" : "left axis") : undefined,
  }));
  return (
    <div className="relative flex h-full w-full flex-col" data-markers={allMarkers.length || undefined} data-breaks={allBreaks.length || undefined}>
      {limited != null && (
        <p className="pointer-events-none absolute bottom-7 right-3 z-10 text-xs text-muted-foreground" data-testid="limited-history">
          Limited history ({limited} {limited === 1 ? "day" : "days"})
        </p>
      )}
      {(allSeries.length > 1) && (
        <ChartLegend
          items={legendItems}
          hidden={toggled.hidden}
          onToggle={toggled.toggle}
          className="mb-1"
          data-testid={dualAll ? "axis-legend" : "series-legend"}
        />
      )}
      <ZoomFrame
        zoom={zoom}
        className="min-h-0 flex-1"
        yAxes={auto.right ? { left: auto.left.domain, right: auto.right.domain } : { left: auto.left.domain }}
        notes={
          <>
            <AxisBaselineNote baseline={scales.left.baseline} />
            {scales.right && <AxisBaselineNote baseline={scales.right.baseline} side="right" />}
          </>
        }
      >
        <div role="group" aria-label={fullLabel} className={`h-full w-full ${CHART_FOCUS_RING}`}>
          <TimeChartPlot
            model={model}
            series={series}
            scales={scales}
            yRanges={zoom.yRanges}
            format={format}
            kind={kind}
            highlight={highlight}
            limited={limited}
            xTicks
          />
        </div>
      </ZoomFrame>
      {table && (
        <ChartDataTable
          caption={fullLabel}
          title={tableTitle ?? defaultTableTitle(series.map((s) => s.label))}
          columns={timeTableColumns(series, format, (s) => s.label)}
          rows={tableRows}
          className="mt-2 shrink-0"
        />
      )}
    </div>
  );
};

/** Series for a stacked plot: each draws on its own left axis. */
type StackedSeries = Omit<SeriesDef, "axis">;

type StackedProps = Omit<TimeChartProps, "series"> & { series: readonly [StackedSeries, StackedSeries] };

/**
 * Body height of a stacked pair: the hero tier, never less than two compact
 * blocks. Like the tiers, it includes the panel padding (the panel is `fit`).
 */
/** The "View data as table" trigger's height below xl (ChartDataTable, max-xl:min-h-11): the stacked plots keep their minimum heights beside it. */
const STACKED_TABLE_SUMMARY_PX = 44;
const STACKED_BODY_HEIGHT = `max(${CHART_HEIGHT.hero}, calc(2 * ${CHART_HEIGHT.compact} + ${2 * PANEL_PADDING_PX + STACKED_TABLE_SUMMARY_PX}px))`;

/** Sizes a `fit` panel body to the stacked pair, so loading and message states take the same space. */
export const StackedBody = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-0 flex-col" style={{ height: `calc(${STACKED_BODY_HEIGHT} - ${2 * PANEL_PADDING_PX}px)` }}>
    {children}
  </div>
);

/**
 * Two plots stacked on one time range. Each series has its own y-axis, baseline
 * and title row, so the two scales never imply a relation. Only the bottom plot
 * labels the x-axis, and a shared syncId makes the tooltip follow across both.
 * Zoom is on the shared x-range only (no Y strips).
 */
export const StackedTimeCharts = ({
  data: allData,
  series,
  format = (n) => formatCompact(n),
  label,
  markers: allMarkers = [],
  breaks: allBreaks = [],
  highlight = null,
  table = true,
  tableTitle,
}: StackedProps) => {
  const syncId = useId();
  const zoom = useChartZoom(allData, (d) => Number(d.t));
  const rows = zoom.rows;
  const markers = useMemo(() => inZoomWindow(allMarkers, zoom.window), [allMarkers, zoom.window]);
  const breaks = useMemo(() => inZoomWindow(allBreaks, zoom.window), [allBreaks, zoom.window]);
  const keys = useMemo(() => series.map((s) => s.key), [series]);
  const model = useMemo(() => buildTimeModel(rows, keys, markers, breaks), [rows, keys, markers, breaks]);
  const tableRows = useMemo(() => tableRowsFor(allData, keys, allBreaks), [allData, keys, allBreaks]);
  const limited = limitedHistoryCount(allData, keys);
  const fullLabel = summarizeLabel(label, allMarkers, allBreaks, limited);
  return (
    <div className="relative flex h-full w-full flex-col" data-markers={allMarkers.length || undefined} data-breaks={allBreaks.length || undefined}>
      {limited != null && (
        <p className="pointer-events-none absolute bottom-7 right-3 z-10 text-xs text-muted-foreground" data-testid="limited-history">
          Limited history ({limited} {limited === 1 ? "day" : "days"})
        </p>
      )}
      <ZoomFrame zoom={zoom} className="min-h-0 flex-1">
        <div role="group" aria-label={fullLabel} className={`flex h-full w-full flex-col ${CHART_FOCUS_RING}`}>
          {series.map((s, i) => {
            const { scales } = sideScales(rows, [s], model.breakTs, zoom);
            const latest = latestValue(allData, s.key);
            // 60 / 40 by height: the first plot takes three parts to the second's two.
            return (
              <div key={s.key} className="flex min-h-0 flex-col" style={{ flex: `${i === 0 ? 3 : 2} 1 0%`, minHeight: CHART_HEIGHT.compact }}>
                <div className="flex shrink-0 flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="h-1.5 w-1.5 shrink-0 self-center rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                  <span className="text-muted-foreground">{s.label}</span>
                  {latest != null && <span className="font-semibold tabular-nums text-foreground">{formatCompact(latest)}</span>}
                  <AxisBaselineNote baseline={scales.left.baseline} />
                </div>
                <div className="relative min-h-0 flex-1">
                  <TimeChartPlot
                    model={model}
                    series={[s]}
                    scales={scales}
                    yRanges={zoom.yRanges}
                    format={format}
                    kind="line"
                    highlight={highlight}
                    limited={limited}
                    xTicks={i === series.length - 1}
                    syncId={syncId}
                    tabStop={i === 0}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </ZoomFrame>
      {table && (
        <ChartDataTable
          caption={fullLabel}
          title={tableTitle ?? defaultTableTitle(series.map((s) => s.label), "balances")}
          columns={timeTableColumns(series, format, (s) => `${s.label} balance`)}
          rows={tableRows}
          className="mt-2 shrink-0"
        />
      )}
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
export const SignedBars = ({ data: allData, format = (n) => formatCompact(n), label, seriesLabel }: SignedBarsProps) => {
  const anim = useChartIntro();
  // Bars sit on a category axis, so the zoom window is in row-index units.
  const zoom = useChartZoom(allData, (_, i) => i);
  const data = zoom.rows;
  const y = useMemo(() => computeYAxisFromRows(data, ["value"], { kind: "bar" }), [data]);
  const yFmt = useMemo(() => distinctTickFormatter(y.ticks, formatCompact), [y]);
  const sizing = barSizing(data.length);
  return (
    <ZoomFrame zoom={zoom} className="h-full w-full">
    <div role="group" aria-label={label} className={`h-full w-full ${CHART_FOCUS_RING}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={MARGIN} barCategoryGap={sizing.barCategoryGap} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <XAxis dataKey="t" tickFormatter={(v) => fmtDate(v)} tick={TICK} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} domain={y.domain} ticks={y.ticks} tickFormatter={yFmt} />
          <ReferenceLine y={0} stroke="hsl(var(--border))" />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            content={<TooltipBox series={[{ key: "value", label: seriesLabel, color: "hsl(var(--primary))" }]} format={format} />}
          />
          <Bar dataKey="value" maxBarSize={sizing.maxBarSize} minPointSize={sizing.minPointSize} isAnimationActive={anim} animationDuration={CHART_DRAW_MS} animationEasing="ease-out">
            {data.map((d) => (
              <Cell key={d.t} fill={d.value >= 0 ? "hsl(var(--ha-positive))" : "hsl(var(--ha-negative))"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
    </ZoomFrame>
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
  const y = useMemo(() => computeYAxisFromRows(data, ["value"], { kind: "bar" }), [data]);
  const yFmt = useMemo(() => distinctTickFormatter(y.ticks, formatCompact), [y]);
  const sizing = barSizing(data.length);
  return (
    <div role="group" aria-label={label} className={`h-full w-full ${CHART_FOCUS_RING}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={MARGIN} barCategoryGap={sizing.barCategoryGap} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} domain={y.domain} ticks={y.ticks} tickFormatter={yFmt} />
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
          <Bar dataKey="value" radius={[2, 2, 0, 0]} maxBarSize={sizing.maxBarSize} minPointSize={sizing.minPointSize} isAnimationActive={anim} animationDuration={CHART_DRAW_MS} animationEasing="ease-out">
            {data.map((d) => (
              <Cell key={d.name} fill={d.highlight ? "hsl(var(--ha-accent))" : "hsl(var(--primary))"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
