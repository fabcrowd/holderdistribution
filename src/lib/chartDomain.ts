/**
 * Y-axis domain helper for multi-series line charts.
 *
 * Extracted from HolderGrowthWidget so the rule it enforces can be tested: a
 * series contributes a bound ONLY if it is actually drawn. Computing "is this
 * showing?" in two places (once for the <Line> list, once for the domain) is
 * what let a hidden single DEX point drag the balance chart's floor from 17.4B
 * to 0 and squash all three real lines into the top fifth of the plot.
 */

export type SeriesDomain = [number, number] | ["auto", "auto"];

type Numeric = number | null | undefined;

/**
 * Padded [min, max] over `keys` across `points`.
 *
 * @param allowNegative when false the floor is clamped at 0 (absolute levels,
 *   where a negative axis would imply negative custody); when true the negative
 *   half is preserved, which a signed delta series needs — clamping there would
 *   hide every period of net selling.
 * @param log when true the domain is made safe for a logarithmic axis: log(0)
 *   is -Infinity, so a floor of 0 makes Recharts render nothing at all. The
 *   floor becomes the smallest POSITIVE value present (padded down by a decade
 *   fraction) and non-positive values are excluded from the bounds entirely —
 *   they cannot be plotted on a log axis regardless. Mutually exclusive with
 *   allowNegative, which is why the caller only offers log in Balance mode.
 */
export const computeSeriesDomain = <T extends Record<string, unknown>>(
  points: T[],
  keys: readonly (keyof T)[],
  { allowNegative = false, log = false }: { allowNegative?: boolean; log?: boolean } = {},
): SeriesDomain => {
  const values: number[] = [];
  for (const point of points) {
    for (const key of keys) {
      const value = point[key] as Numeric;
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        values.push(value as number);
      }
    }
  }
  if (values.length === 0) return ["auto", "auto"];

  if (log) {
    const positive = values.filter((value) => value > 0);
    if (positive.length === 0) return ["auto", "auto"];
    const lo = Math.min(...positive);
    const hi = Math.max(...positive);
    // Pad by a fraction of a decade rather than a linear delta: on a log axis a
    // linear pad is invisible at the top and can drive the floor <= 0 at the
    // bottom, which is the failure this branch exists to avoid.
    return [lo / 1.5, hi * 1.5];
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max(1, max - min) * 0.05;
  const floor = allowNegative ? min - padding : Math.max(0, min - padding);
  return [floor, max + padding];
};

/** Keys whose flag is true, for feeding straight into computeSeriesDomain. */
export const activeKeys = <K extends string>(flags: Record<K, boolean>): K[] =>
  (Object.keys(flags) as K[]).filter((key) => flags[key]);

/**
 * A declared break only stops dominating the axis when the older side is a
 * short stretch next to the current basis. An older segment is folded into the
 * domain when it covers at least as much time as the newest segment (a long
 * view's real history must stay on the plot), or when including it keeps the
 * span within this multiple of the newest segment's own span (a small step).
 * Otherwise it is a methodology artefact that would flatten the real trend and
 * is left to clip at the plot edge.
 */
export const BREAK_DOMAIN_SPAN_FACTOR = 3;

/**
 * Per key, the original rows whose segment the BREAK_DOMAIN_SPAN_FACTOR rule
 * admits. Rows are kept by identity so callers can match them back to input.
 * This is the single definition of the rule; the domain and the mask both
 * read it.
 */
const keptRowsByKey = <T extends Record<string, unknown>>(
  points: T[],
  keys: readonly (keyof T)[],
  breakTs: readonly number[],
  timeKey: keyof T,
): Map<keyof T, Set<T>> => {
  const sorted = [...breakTs].sort((a, b) => b - a);
  const segments: T[][] = [];
  let rest = [...points].sort((x, y) => (x[timeKey] as number) - (y[timeKey] as number));
  for (const b of sorted) {
    segments.push(rest.filter((p) => (p[timeKey] as number) >= b));
    rest = rest.filter((p) => (p[timeKey] as number) < b);
  }
  segments.push(rest);
  const duration = (rows: T[]): number =>
    rows.length ? (rows[rows.length - 1][timeKey] as number) - (rows[0][timeKey] as number) : 0;
  // Decided per series: a jump in one line must not be hidden by the span of
  // another (balance vs exchange lines sit at very different levels).
  const kept = new Map<keyof T, Set<T>>();
  for (const key of keys) {
    const spanOf = (rows: T[]): number => {
      const [lo, hi] = computeSeriesDomain(rows, [key], { allowNegative: true });
      return typeof lo === "number" && typeof hi === "number" ? hi - lo : 0;
    };
    const own = segments.map((s) => s.filter((p) => p[key] != null));
    const newest = own.find((s) => s.length) ?? [];
    const budget = Math.max(1, spanOf(newest)) * BREAK_DOMAIN_SPAN_FACTOR;
    let included: T[] = [];
    for (const segment of own) {
      if (!segment.length) continue;
      const candidate = [...segment, ...included];
      const keep = !included.length || duration(segment) >= duration(newest) || spanOf(candidate) <= budget;
      if (keep) included = candidate;
    }
    kept.set(key, new Set(included));
  }
  return kept;
};

/**
 * Like computeSeriesDomain, but segment-aware: `breakTs` are timestamps where
 * the series changed basis; see BREAK_DOMAIN_SPAN_FACTOR for the rule.
 */
export const computeBreakAwareDomain = <T extends Record<string, unknown>>(
  points: T[],
  keys: readonly (keyof T)[],
  breakTs: readonly number[],
  timeKey: keyof T,
  options: { allowNegative?: boolean; log?: boolean } = {},
): SeriesDomain => {
  if (!breakTs.length) return computeSeriesDomain(points, keys, options);
  const kept = keptRowsByKey(points, keys, breakTs, timeKey);
  const rows: Record<string, unknown>[] = [];
  for (const key of keys) {
    for (const p of kept.get(key) ?? []) rows.push({ [key as string]: p[key] });
  }
  return computeSeriesDomain(rows, keys as readonly string[], options);
};

/**
 * Copy of `points` where each key's value is nulled on rows whose segment the
 * domain rule excludes. Those segments are not drawn at all, so a short island
 * between two breaks does not appear as a clipped stub at the plot edge. Rows
 * and timestamps are kept, so markers, notes and spacers still line up.
 * Returns `points` itself when there are no breaks. Input is not mutated.
 */
export const maskExcludedSegments = <T extends Record<string, unknown>>(
  points: T[],
  keys: readonly (keyof T)[],
  breakTs: readonly number[],
  timeKey: keyof T,
): T[] => {
  if (!breakTs.length) return points;
  const kept = keptRowsByKey(points, keys, breakTs, timeKey);
  return points.map((p) => {
    let row = p;
    for (const key of keys) {
      if (p[key] == null || kept.get(key)?.has(p)) continue;
      row = { ...row, [key]: null } as T;
    }
    return row;
  });
};
