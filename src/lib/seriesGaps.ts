/**
 * Chart-series gap handling.
 *
 * The data pipeline is expected to produce one snapshot per day, so a line
 * chart over `holders-history.json` can normally join consecutive points
 * directly. When a run is missed the series simply has no entry for those
 * dates, and a line chart will happily draw a straight segment across them —
 * presenting unmeasured time as observed data. That is exactly what the
 * 2026-08-11 → 08-14 pipeline outage looked like on /holders: a confident flat
 * four-day line (see the 2026-08-11-pipeline-outage event in
 * config/classification-changelog.json; no tel-holders.json blob exists for
 * those dates, so the gap is permanent and can only be disclosed).
 *
 * Recharts breaks a line wherever the dataKey is null, and `connectNulls` is
 * off by default — so inserting a null-valued point inside the gap is all that
 * is needed. The spacer carries no value, so it cannot affect the axis domain,
 * a delta calculation, or a tooltip reading.
 *
 * WHY NOT SIMPLY BREAK ON EVERY GAP
 *
 * The archive's own sampling cadence changed: it was weekly through early 2026
 * and daily from 2026-03-01. Breaking on every gap wider than a day erases that
 * whole early era — each weekly sample has a multi-day gap on BOTH sides, so it
 * becomes an isolated point, and with `dot={false}` an isolated point renders as
 * nothing at all. (Observed directly: the YTD chart's line path came back as
 * eight subpaths, several of the form `M155,49Z` — a single moveto with no line
 * to draw.) A deliberate weekly sampling interval is not a gap in the data; a
 * missed run in a daily series is. So a break is only inserted where the series
 * is otherwise being sampled daily on both sides, which is exactly the outage
 * case and leaves the weekly era drawn as the continuous line it always was.
 */

export type GapAwarePoint = {
  timestamp: number;
  /** Whole days since the previous sample; null on the first point. */
  gapDays: number | null;
};

/**
 * Returns `points` with a null-valued spacer inserted inside every gap that
 * interrupts a daily-sampled stretch. `nullFields` names the numeric keys to
 * null out on the spacer — every dataKey the chart draws, or that series will
 * connect straight across the break anyway.
 *
 * `points` must be sorted ascending by timestamp.
 */
export const insertGapBreaks = <T extends GapAwarePoint>(
  points: T[],
  nullFields: (keyof T)[],
): (T | (Partial<T> & { timestamp: number }))[] => {
  const result: (T | (Partial<T> & { timestamp: number }))[] = [];

  points.forEach((point, index) => {
    const previous = index > 0 ? points[index - 1] : null;
    const next = index + 1 < points.length ? points[index + 1] : null;
    // Both neighbours must be daily samples, so the break lands in a series
    // that was genuinely being measured every day — and so neither side is
    // left as an isolated, invisible single point.
    const interruptsDailySampling =
      previous?.gapDays === 1 && next?.gapDays === 1;
    if (previous && point.gapDays !== null && point.gapDays > 1 && interruptsDailySampling) {
      const spacer = { timestamp: Math.round((previous.timestamp + point.timestamp) / 2) } as Partial<T> & {
        timestamp: number;
      };
      for (const field of nullFields) {
        (spacer as Record<keyof T, unknown>)[field] = null;
      }
      result.push(spacer);
    }
    result.push(point);
  });

  return result;
};
