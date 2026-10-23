const MIN_TOLERANCE_DAYS = 3;
// Applies only when the resolved match is the archive's own earliest point
// and the true target predates it — i.e. "the archive doesn't go back far
// enough," not "a real nearby point with a gap before it." The main
// tolerance below (days * 0.5) is generous enough to paper over that for
// long ranges (e.g. a 365-day "1Y" request matching a ~204-day-old archive's
// earliest point, 161 days off) which silently renders "1Y" as whatever the
// archive actually covers. This tighter, flat cap only forgives a genuinely
// short shortfall (comparable to YTD's — the target date is usually a few
// weeks before the archive's own start) while rejecting a range the archive
// is nowhere near old enough to answer.
const EDGE_TOLERANCE_DAYS = 30;

/**
 * Finds the point in `points` closest to `days` ago (relative to the latest
 * point's timestamp), rejecting the match if it drifts more than
 * max(3, days * 0.5) days from the target — better to report "no baseline"
 * than silently mislabel a comparison after a gap in the snapshot archive.
 */
export function pickBaseline<T>(
  points: T[],
  days: number,
  getTs: (point: T) => number,
): T | null {
  const pts = points
    .map((p) => ({ p, ts: getTs(p) }))
    .filter((x) => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);
  if (pts.length === 0) return null;

  const latestTs = pts[pts.length - 1].ts;
  const targetTs = latestTs - days * 86400000;
  // Never the latest point itself: with a gap in the archive (e.g. nothing
  // between Oct 2 and Oct 23) a 1D request used to pick today's own row and
  // report "0" for every delta. No earlier point in tolerance → no baseline.
  const earlier = days > 0 ? pts.filter((x) => x.ts < latestTs) : pts;
  if (earlier.length === 0) return null;
  let best = earlier[0];
  for (const x of earlier) {
    if (Math.abs(x.ts - targetTs) < Math.abs(best.ts - targetTs)) best = x;
  }

  const toleranceMs = Math.max(MIN_TOLERANCE_DAYS, days * 0.5) * 86400000;
  if (Math.abs(best.ts - targetTs) > toleranceMs) return null;

  if (best.ts === pts[0].ts && targetTs < best.ts) {
    const edgeToleranceMs = EDGE_TOLERANCE_DAYS * 86400000;
    if (best.ts - targetTs > edgeToleranceMs) return null;
  }

  return best.p;
}

/** Centralizes the "prior snapshot" fallback string used when no reference date is known. */
export function baselineLabel(referenceDate: string | null | undefined, fallback = "prior snapshot"): string {
  return referenceDate ?? fallback;
}
