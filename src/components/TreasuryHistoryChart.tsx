import { useMemo, useState } from "react";
import { PanelError } from "@/components/terminal/TerminalPanel";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import "@/lib/rechartsMotion";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useTreasuryHistory } from "@/hooks/useTreasuryHistory";
import { activeKeys } from "@/lib/chartDomain";
import { computeYAxisFromRows, distinctTickFormatter } from "@/lib/chartAxes";
import { AxisBaselineNote } from "@/components/chart/AxisBaselineNote";
import { formatChartTimestamp } from "@/lib/chartDate";
import { COMPACT_AXIS, formatCompact } from "@/lib/format";
import { InfoTooltip } from "@/components/InfoTooltip";
import { ZoomFrame } from "@/components/chart/ZoomFrame";
import { useChartZoom } from "@/hooks/useChartZoom";
import { toggleHidden } from "@/lib/chartZoom";
import { useProjectCopy, type UseProjectCopy } from "@/hooks/useProjectCopy";
import { useProject } from "@/hooks/useProject";
import { copyTextsByPrefix } from "@/lib/projectCopy";
import type { ProjectConfig } from "@/lib/projects";
import { developerCategoryLabel, resolveDeveloperHoldings } from "@/lib/supplyBreakdown";
import { datedNotes, groupMarkers, markerCollapseGap, markerNotesByRow } from "@/lib/chartMarkers";
import { NotedTooltip, markerLines } from "@/components/chart/ChartMarkers";

/**
 * Project-held balances over time, one line per group.
 *
 * ENTITY STRUCTURE — the thing this chart must never blur:
 *
 *   Telcoin Association  (umbrella)
 *     ├─ Treasury            category `treasury`  — the TEL Treasury address
 *     └─ TAO & Safes         category `council`   — TAO Safe / TAO Distribution /
 *                                                   TAO Implementation, the TAN,
 *                                                   TELx, Platform, Compliance and
 *                                                   Treasury Councils, and the
 *                                                   Developer / Staker / Validator /
 *                                                   Miner Safes
 *   Telcoin Holdings     (SEPARATE ENTITY)  category `holdings`
 *
 * Telcoin Association and Telcoin Holdings are DISTINCT ENTITIES and are never
 * summed into a combined "team" figure — see lessons.md. The two Association
 * lines are prefixed "Association — " precisely so splitting them cannot be
 * misread as two separate organisations, while Holdings stays unprefixed and
 * visibly apart.
 *
 * `treasury` and `council` used to share one "Association Safes" line. They are
 * different subsets of the same umbrella, so they are now plotted separately
 * and named for it. `treasury-history.json` has always stored them as separate
 * keys per date, so this is a rendering change only, with no pipeline re-run.
 *
 * The lines are built from the categories actually present in the feed
 * (all-zero ones are dropped), so a token with team / staking categories plots
 * them and one without council or escrow shows no dead chips. `staking-contract`
 * is never plotted: reconcile-supply.js emits it as ~0 (staked TEL is
 * attributed to individual stakers instead).
 *
 * Note the pie above still groups Association = treasury + council, so the two
 * surfaces differ in granularity by design — the copy says so rather than
 * leaving a reader to reconcile 1.33B against 1.77B on one screen.
 */
type Series = { key: string; color: string };
type Mode = "balance" | "change";

/**
 * Line colours by position in the stable category order. The first four are
 * the original treasury / council / holdings / escrow colours (TEL's order);
 * further categories take the theme's semantic slice tokens.
 */
const SERIES_PALETTE: readonly string[] = [
  "hsl(262 83% 58%)",
  "hsl(158 64% 42%)",
  "hsl(217 91% 60%)",
  "hsl(28 90% 55%)",
  "hsl(var(--supply-dex))",
  "hsl(var(--supply-cex))",
  "hsl(var(--supply-developer))",
  "hsl(var(--primary))",
];

/** Categories deliberately not plotted: emitted as 0, or already counted elsewhere. */
const IGNORED_CATEGORY_KEYS: readonly string[] = ["staking-contract"];

/**
 * One line per category with a non-zero balance on any date. Order: the
 * project's developerHoldings sub-categories, then treasury.categories, then
 * anything else alphabetically. Colours follow that order before zero series
 * are dropped, so a line keeps its colour when another category empties.
 */
export const buildSeries = (
  entries: ReadonlyArray<{ categories?: Record<string, number> }>,
  project: Pick<ProjectConfig, "supply" | "treasury">,
): Series[] => {
  const present = new Set<string>();
  const nonZero = new Set<string>();
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.categories ?? {})) {
      if (IGNORED_CATEGORY_KEYS.includes(key)) continue;
      present.add(key);
      if (Number(value)) nonZero.add(key);
    }
  }
  const configured = [
    ...(project.supply?.developerHoldings?.subcategories ?? []).map((s) => s.category),
    ...(project.treasury?.categories ?? []),
  ];
  const ordered = [
    ...new Set(configured.filter((c) => present.has(c))),
    ...[...present].filter((c) => !configured.includes(c)).sort(),
  ];
  return ordered
    .map((key, i) => ({ key, color: SERIES_PALETTE[i % SERIES_PALETTE.length] }))
    .filter((s) => nonZero.has(s.key));
};

/**
 * Line label per category. The two foundation lines share the entity prefix
 * (TEL: "Association — ") and the team line is the separate entity's own name
 * (TEL: "Telcoin Holdings"), so the split stays readable. Other categories
 * use their developer-holdings label.
 */
const seriesLabel = (key: string, copy: Pick<UseProjectCopy, "entities" | "text">, project: Pick<ProjectConfig, "supply">): string => {
  switch (key) {
    case "treasury":
      return `${copy.entities.associationShort} — Treasury`;
    case "council":
      return copy.text("treasury.series.council", `${copy.entities.associationShort} — Council & Safes`);
    case "holdings":
      return copy.entities.holdings;
    case "escrow":
      return "Escrow";
    default:
      return developerCategoryLabel(resolveDeveloperHoldings(project.supply?.developerHoldings), key);
  }
};

/**
 * Lines switched off on first render: copy.text "treasury.history.hiddenByDefault"
 * (comma-separated categories), default "escrow" (third-party custody that
 * dwarfs the rest). Never hides every line.
 */
const hiddenByDefault = (copy: Pick<UseProjectCopy, "text">, keys: readonly string[]): ReadonlySet<string> => {
  const wanted = copy.text("treasury.history.hiddenByDefault", "escrow").split(",").map((s) => s.trim());
  const hidden = keys.filter((k) => wanted.includes(k));
  return hidden.length >= keys.length ? new Set() : new Set(hidden);
};

/** Tooltip copy; TEL names its entities and custodians via copy.text "treasury.history.info". */
const historyInfo = (
  copy: Pick<UseProjectCopy, "entities" | "text">,
  keys: readonly string[],
  hidden: ReadonlySet<string>,
): string => {
  const { associationShort: a, holdings: h } = copy.entities;
  const has = (k: string) => keys.includes(k);
  const paragraphs = ["Daily balances reconstructed from on-chain Transfer logs, one line per group."];
  if (has("treasury") && has("council")) {
    paragraphs.push(
      `The two "${a} —" lines are subsets of ONE entity: its Treasury address, and its council / ops Safes. The pie above combines them into a single bucket, so it shows one figure where this chart shows two.`,
    );
  }
  if (has("holdings") && (has("treasury") || has("council"))) {
    paragraphs.push(`${h} is a SEPARATE entity, and the two are never combined into a single figure.`);
  }
  if (has("escrow")) {
    paragraphs.push(
      `Escrow is third-party custody — not discretionary supply${hidden.has("escrow") ? ", and hidden by default because it dwarfs the rest" : ""}.`,
    );
  }
  return copy.text("treasury.history.info", paragraphs.join("\n\n"));
};

/** `digits` is the precision the axis needs to keep neighbouring gridlines distinct. */
const formatCompactAmount = (value: number, unit: string, digits = 1) =>
  `${formatCompact(value, { ...COMPACT_AXIS, digits: Math.max(2, digits), millionDigits: Math.max(1, digits) })} ${unit}`;
const formatSignedAmount = (value: number, unit: string) => {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCompactAmount(Math.abs(value), unit)}`;
};

/** Flip one line on/off; the last visible line cannot be switched off. */
const toggleVisible = (prev: Record<string, boolean>, key: string): Record<string, boolean> => {
  const keys = Object.keys(prev);
  const hidden = toggleHidden(new Set(keys.filter((k) => !prev[k])), key, keys);
  return Object.fromEntries(keys.map((k) => [k, !hidden.has(k)]));
};

/**
 * `compact` (the desktop terminal): no section rule, chips share the title
 * row and the plot is shorter, so the whole chart fits the history panel at
 * 1440x900 instead of being cut off at the bottom.
 */
export const TreasuryHistoryChart = ({ rangeDays, compact = false }: { rangeDays: number; compact?: boolean }) => {
  const { data, isError } = useTreasuryHistory();
  const copy = useProjectCopy();
  const { project } = useProject();
  const series = useMemo(() => buildSeries(data?.entries ?? [], project), [data?.entries, project]);
  const keys = useMemo(() => series.map((s) => s.key), [series]);
  const labels = useMemo(
    () => Object.fromEntries(keys.map((k) => [k, seriesLabel(k, copy, project)])) as Record<string, string>,
    [keys, copy, project],
  );
  const chartConfig = useMemo(
    () => Object.fromEntries(series.map((s) => [s.key, { label: labels[s.key], color: s.color }])),
    [series, labels],
  );
  // Escrow off by default (TEL: roughly two-thirds of the total, third-party
  // custody); projects change this via copy.text "treasury.history.hiddenByDefault".
  const defaultHidden = useMemo(() => hiddenByDefault(copy, keys), [copy, keys]);
  const [overrides, setOverrides] = useState<Record<string, boolean> | null>(null);
  const visible = useMemo(
    () => Object.fromEntries(keys.map((k) => [k, overrides?.[k] ?? !defaultHidden.has(k)])) as Record<string, boolean>,
    [keys, overrides, defaultHidden],
  );
  const [mode, setMode] = useState<Mode>("balance");

  const points = useMemo(() => {
    const entries = data?.entries ?? [];
    if (entries.length === 0) return [];
    const rows = entries.map((entry) => {
      const row: Record<string, number> = { timestamp: Date.parse(entry.date) };
      for (const key of keys) {
        row[key] = Number(entry.categories?.[key]) || 0;
      }
      return row;
    });
    const latest = rows[rows.length - 1]?.timestamp;
    const cutoff = Number.isFinite(latest) ? latest - rangeDays * 86400000 : null;
    return cutoff === null ? rows : rows.filter((r) => r.timestamp >= cutoff);
  }, [data?.entries, rangeDays, keys]);

  const display = useMemo(() => {
    if (mode === "balance" || points.length === 0) return points;
    const base = points[0];
    return points.map((p) => {
      const row: Record<string, number> = { timestamp: p.timestamp };
      for (const key of keys) {
        row[key] = p[key] - base[key];
      }
      return row;
    });
  }, [points, mode, keys]);

  const zoom = useChartZoom(display, (d) => d.timestamp);
  // Fitted to the visible rows and the lines switched on.
  const yAuto = useMemo(
    () => computeYAxisFromRows(zoom.rows, activeKeys(visible), { kind: "line", allowNegative: mode === "change" }),
    [zoom.rows, visible, mode],
  );
  const yScale = zoom.yScale("left", yAuto);

  const notes = useMemo(() => datedNotes(copyTextsByPrefix(project, "treasury.note.")), [project]);
  const rowTimes = useMemo(() => zoom.rows.map((r) => r.timestamp), [zoom.rows]);
  const visibleNotes = useMemo(
    () => notes.filter((n) => rowTimes.length > 0 && n.t >= rowTimes[0] && n.t <= rowTimes[rowTimes.length - 1]),
    [notes, rowTimes],
  );
  const markers = useMemo(() => groupMarkers(visibleNotes, markerCollapseGap(rowTimes)), [visibleNotes, rowTimes]);
  // gap 0: each note stays on its own date's row, so hovering 10-01 shows the 10-01 note.
  const notesByRow = useMemo(() => markerNotesByRow(rowTimes, groupMarkers(visibleNotes, 0)), [visibleNotes, rowTimes]);

  if (isError) return <div className="min-h-[8rem]"><PanelError>Couldn&apos;t load treasury history.</PanelError></div>;
  if (!data || points.length < 2) return null;

  const fmt = (v: number) => (mode === "change" ? formatSignedAmount : formatCompactAmount)(v, copy.ticker);
  const axisFmt = distinctTickFormatter(yScale.ticks, (v, d) => (mode === "change" ? formatSignedAmount : formatCompactAmount)(v, copy.ticker, d));
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  const tipFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

  return (
    <div className={compact ? "" : "pt-5 mt-5 border-t border-border/40"} data-testid="treasury-history-chart">
      <div className={`flex flex-wrap items-center gap-2 ${compact ? "mb-2" : "mb-3"}`}>
        <span className="font-medium text-foreground text-sm">Project-held balances over time</span>
        <InfoTooltip text={historyInfo(copy, keys, defaultHidden)} />
        <div className="inline-flex rounded-full border border-border/60 bg-card/80 p-0.5 ml-auto">
          {(["balance", "change"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`text-xs font-semibold rounded-full px-3 py-1 max-xl:min-h-11 transition-colors ${
                mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-primary"
              }`}
            >
              {m === "balance" ? "Balance" : "Change"}
            </button>
          ))}
        </div>
      </div>

      <div className={`flex flex-wrap items-center gap-2 ${compact ? "mb-2" : "mb-3"}`}>
        {series.map(({ key, color }) => {
          const on = visible[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => setOverrides(toggleVisible(visible, key))}
              aria-pressed={on}
              // Series colour on the border + dot, never as the text
              // background: white on these mid-tone hues failed AA (2.8:1).
              className={`inline-flex ${compact ? "min-h-7" : "min-h-[44px]"} items-center gap-1.5 rounded-full border-2 px-2.5 py-1 text-xs font-medium transition-colors ${
                on ? "bg-card text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
              style={on ? { borderColor: color } : undefined}
            >
              <span
                className={`h-2 w-2 rounded-full ${on ? "" : "opacity-50"}`}
                style={{ backgroundColor: color }}
              />
              {labels[key]}
            </button>
          );
        })}
      </div>

      <ZoomFrame zoom={zoom} className={`${compact ? "h-44" : "h-56"} w-full`} yAxes={{ left: yAuto.domain }} notes={<AxisBaselineNote baseline={yScale.baseline} format={fmt} />}>
        <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
          <LineChart data={zoom.rows} margin={{ top: 10, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={(v) => formatChartTimestamp(v, dateFmt)}
              tickMargin={8}
            />
            <YAxis tickFormatter={(v) => axisFmt(Number(v))} domain={yScale.domain} ticks={yScale.ticks} allowDataOverflow={zoom.yRanges.left != null} tickMargin={8} width={56} />
            <ChartTooltip
              content={
                <NotedTooltip
                  notes={notesByRow}
                  base={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        formatChartTimestamp(payload?.[0]?.payload?.timestamp, tipFmt)
                      }
                      formatter={(value, name) => [fmt(Number(value)), labels[String(name)] ?? String(name)]}
                    />
                  }
                />
              }
            />
            {mode === "change" && <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />}
            {keys.map((key) =>
              visible[key] ? (
                <Line
                  key={key}
                  dataKey={key}
                  type="monotone"
                  stroke={`var(--color-${key})`}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ) : null,
            )}
            {markerLines(markers, "treasury-note")}
          </LineChart>
        </ChartContainer>
      </ZoomFrame>
    </div>
  );
};
