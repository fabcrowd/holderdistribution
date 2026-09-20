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
