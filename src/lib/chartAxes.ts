/**
 * Which y-axis each series of a multi-series chart belongs to.
 *
 * Rule: series in different units (holders vs token amount) or at wildly
 * different scales (retail vs CEX balance) never share an axis. A series says
 * so with `axis: "right"`, or declares a `unit` that differs from the first
 * series' unit and is moved to the right axis automatically.
 */

export type AxisSide = "left" | "right";

export type AxisSeries = { key: string; axis?: AxisSide; unit?: string };

export const assignAxes = (series: readonly AxisSeries[]): Record<string, AxisSide> => {
  const baseUnit = series.find((s) => s.unit != null)?.unit;
  const out: Record<string, AxisSide> = {};
  for (const s of series) {
    out[s.key] = s.axis ?? (s.unit != null && baseUnit != null && s.unit !== baseUnit ? "right" : "left");
  }
  // A right axis only exists alongside a left one.
  if (!Object.values(out).includes("left")) for (const k of Object.keys(out)) out[k] = "left";
  return out;
};

/** Keys on one side of the chart. */
export const keysOnAxis = (series: readonly AxisSeries[], side: AxisSide): string[] => {
  const axes = assignAxes(series);
  return series.filter((s) => axes[s.key] === side).map((s) => s.key);
};

/** True when a right axis is needed. */
export const hasRightAxis = (series: readonly AxisSeries[]): boolean => Object.values(assignAxes(series)).includes("right");
