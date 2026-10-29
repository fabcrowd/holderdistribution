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

/* ------------------------------------------------------------------ *
 * Y-domain: one rule for every chart, computed from what is drawn.
 *
 * Callers pass the rows inside the zoom window and only the series that are
 * not toggled off, so the axis always fits the visible data.
 *   - bars:  zero baseline, max scaled to the data plus headroom, nice ticks
 *   - lines/areas: when the visible values barely move relative to their
 *     level, a padded non-zero baseline so the movement is readable; the
 *     chart then shows a "axis starts at" note (see AxisBaselineNote).
 * ------------------------------------------------------------------ */

export type YAxisKind = "line" | "bar";

export type YAxisScale = {
  domain: [number, number];
  ticks: number[];
  /** Set when the axis does not start at zero: the value shown at the bottom. */
  baseline: number | null;
};

/** Approximate gridline count; the nice step lands between this and about double. */
export const Y_TARGET_TICKS = 5;
/** Bar headroom above the tallest bar. */
export const BAR_HEADROOM = 0.08;
/** Line/area padding on each side of the visible span when the baseline is not zero. */
export const LINE_PAD = 0.1;
/**
 * A line/area gets a non-zero baseline when its visible span is under this
 * share of its level (max of |values|). 0.5 means a series that stays within
 * the top half of its range reads better zoomed in than squashed against zero.
 */
export const NON_ZERO_BASELINE_MAX_SPAN_RATIO = 0.5;

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/** Smallest "nice" step (1, 2, 2.5, 5 x 10^n) that is at least `raw`. */
export const niceStep = (raw: number): number => {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / pow;
  const pick = NICE_STEPS.find((s) => s >= frac - 1e-9) ?? 10;
  return pick * pow;
};

/** Round away binary noise (0.30000000000000004) at the step's own precision. */
const clean = (v: number, step: number): number => {
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(step)));
  return Number(v.toFixed(Math.min(decimals, 12))) + 0;
};

const MIN_TICKS = 4;
const MAX_TICKS = 8;

/**
 * Gridlines that cover [lo, hi]; the domain is first..last. Of the nice steps
 * giving a readable number of lines, the one that overshoots the data least
 * wins, so 0..106 reads 0..120 rather than 0..150.
 */
export const niceTicks = (lo: number, hi: number, target = Y_TARGET_TICKS, minStep = 0): number[] => {
  if (!(hi > lo)) return [clean(lo, 1), clean(lo + 1, 1)];
  const base = Math.max(minStep, niceStep((hi - lo) / Math.max(1, target - 1)));
  const pow = 10 ** Math.floor(Math.log10(base));
  let best: { step: number; first: number; last: number } | null = null;
  for (const mult of [0.1, 1, 10]) {
    for (const n of NICE_STEPS) {
      const step = n * pow * mult;
      if (step < minStep) continue;
      const first = Math.floor(lo / step + 1e-9);
      const last = Math.ceil(hi / step - 1e-9);
      const count = last - first + 1;
      if (count < MIN_TICKS || count > MAX_TICKS) continue;
      const range = (last - first) * step;
      const bestRange = best ? (best.last - best.first) * best.step : Infinity;
      const closer = Math.abs(count - target) < Math.abs(best ? best.last - best.first + 1 - target : Infinity);
      if (range < bestRange - 1e-9 * step || (Math.abs(range - bestRange) <= 1e-9 * step && closer)) best = { step, first, last };
    }
  }
  const { step, first, last } = best ?? { step: base, first: Math.floor(lo / base), last: Math.ceil(hi / base) };
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(clean(i * step, step));
  return ticks;
};

const finite = (values: readonly (number | null | undefined)[]): number[] =>
  values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

const scaleOf = (lo: number, hi: number, baseline: boolean, minStep = 0): YAxisScale => {
  const ticks = niceTicks(lo, hi, Y_TARGET_TICKS, minStep);
  const domain: [number, number] = [ticks[0], ticks[ticks.length - 1]];
  return { domain, ticks, baseline: baseline && domain[0] !== 0 ? domain[0] : null };
};

export type YAxisOptions = {
  kind: YAxisKind;
  /** Floor at zero when the data has no negatives (default). Set for signed series that may dip below 0. */
  allowNegative?: boolean;
  /** Extra room beyond the data as a fraction (bar default 8%); raise it when value labels sit at the bar ends. */
  headroom?: number;
  /** Whole-number data (wallet counts): gridlines never fall between integers. */
  integer?: boolean;
};

/**
 * Domain, ticks and baseline flag for the visible values of one axis.
 * Handles empty data, a single point, all-equal values and negatives.
 */
export const computeYAxis = (values: readonly (number | null | undefined)[], { kind, allowNegative = true, headroom = BAR_HEADROOM, integer = false }: YAxisOptions): YAxisScale => {
  const minStep = integer ? 1 : 0;
  const make = (lo: number, hi: number, baseline: boolean) => scaleOf(lo, hi, baseline, minStep);
  const v = finite(values);
  if (v.length === 0) return make(0, 1, false);
  const min = Math.min(...v);
  const max = Math.max(...v);

  if (kind === "bar") {
    // Bars encode length from zero, so the baseline never moves.
    const hi = Math.max(0, max);
    const lo = Math.min(0, min);
    if (hi === 0 && lo === 0) return make(0, 1, false);
    return make(lo < 0 ? lo * (1 + headroom) : 0, hi > 0 ? hi * (1 + headroom) : 0, false);
  }

  const span = max - min;
  const level = Math.max(Math.abs(min), Math.abs(max));
  const sameSign = min >= 0 || max <= 0;
  const tight = sameSign && level > 0 && span < level * NON_ZERO_BASELINE_MAX_SPAN_RATIO;

  if (!tight) {
    // Far from flat (or straddling zero): keep zero in view with a little room.
    const lo = min < 0 && allowNegative ? min * (1 + headroom) : 0;
    const hi = max > 0 ? max * (1 + headroom) : 0;
    if (lo === 0 && hi === 0) return make(0, 1, false);
    return make(lo, hi, false);
  }
  // A flat line has no span to pad by: pad by a share of its level instead.
  const pad = span > 0 ? span * LINE_PAD : level * 0.05;
  let lo = min - pad;
  const hi = max + pad;
  if (!allowNegative || min >= 0) lo = Math.max(0, lo);
  return make(lo, hi, true);
};

/** Collect finite values of `keys` across `rows` (the visible rows) and scale them. */
export const computeYAxisFromRows = <T extends object>(rows: readonly T[], keys: readonly string[], options: YAxisOptions): YAxisScale => {
  const values: number[] = [];
  for (const row of rows) {
    for (const k of keys) {
      const x = (row as Record<string, unknown>)[k];
      if (typeof x === "number") values.push(x);
    }
  }
  return computeYAxis(values, options);
};

/** "96.0K" -> "96K", "1.50B" -> "1.5B": narrower labels, never merges distinct ones. */
const trimZeros = (label: string): string =>
  label.replace(/(\.\d*?)0+(?=\D|$)/, "$1").replace(/\.(?=\D|$)/, "");

/**
 * Tick label formatter that never prints two gridlines with the same text
 * (a tight 17.41B..17.44B axis would otherwise read 17.4B / 17.4B / 17.4B).
 */
export const distinctTickFormatter = (ticks: readonly number[], format: (v: number, digits: number) => string, maxDigits = 3) => {
  let digits = 1;
  for (; digits < maxDigits; digits++) {
    const labels = ticks.map((t) => format(t, digits));
    if (new Set(labels).size === labels.length) break;
  }
  return (v: number) => trimZeros(format(v, digits));
};

/* ---- bar sizing ---- */

export type BarSizing = {
  maxBarSize: number;
  barCategoryGap: string;
  /** Recharts calls this with the bar's value; zero stays zero-height. */
  minPointSize: (value: unknown) => number;
};

/** Widest a single bar gets, so two or three bars never turn into slabs. */
export const MAX_BAR_PX = 56;
/** A non-zero bar is never thinner than this tall, so small values stay visible. */
export const MIN_BAR_POINT_PX = 3;

/**
 * Bar thickness for a category/time axis of `count` bars: capped width, a gap
 * that loosens as bars get fewer, and a minimum drawn height.
 */
export const barSizing = (count: number): BarSizing => ({
  maxBarSize: MAX_BAR_PX,
  barCategoryGap: count <= 4 ? "30%" : count <= 12 ? "20%" : "10%",
  minPointSize: (value) => (typeof value === "number" && value !== 0 ? MIN_BAR_POINT_PX : 0),
});
