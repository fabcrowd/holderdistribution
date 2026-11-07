/**
 * One window end shared by every exchange widget, so the measured-flow panel
 * and the balance table cover the identical interval [end - N days, end).
 *
 * `end` is EXCLUSIVE. Feed contract: `asOf.date = D` means D is the last
 * settled day (state is end-of-D), so end = D + 1 day 00:00 UTC. Without an
 * asOf, end = today 00:00 UTC: the in-progress UTC day is never part of a window.
 */
import { pickNearestBaseline } from "./baseline";
import { ytdDays } from "./timeRange";
import { type ClassificationChangelog, type ClassificationEvent } from "./classificationChangelog";

export const DAY_MS = 86_400_000;

export const utcMidnightMs = (now: Date): number => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/**
 * asOf.settled === false: asOf.date is the in-progress run day, so it is excluded (end = asOf.date 00:00Z).
 * asOf.settled === false with no date: the feed has no settled day; end = the day after
 * `fallbackLastRowMs` (the feed's last settled row, 00:00Z of its date), or today 00:00Z if none.
 */
export const settledEndMs = (
  feed: { asOf?: { date?: string | null; settled?: boolean } | null } | null | undefined,
  now: Date = new Date(),
  fallbackLastRowMs?: number | null,
): number => {
  const declared = feed?.asOf?.date ? Date.parse(feed.asOf.date) : NaN;
  if (!Number.isFinite(declared)) {
    const unsettled = feed?.asOf?.settled === false;
    if (unsettled && fallbackLastRowMs != null && Number.isFinite(fallbackLastRowMs)) {
      return Math.min(Math.floor(fallbackLastRowMs / DAY_MS) * DAY_MS + DAY_MS, utcMidnightMs(now));
    }
    return utcMidnightMs(now);
  }
  return feed?.asOf?.settled === false ? declared : declared + DAY_MS;
};

/** Half-open window [end - days, end); days < 1 counts as 1. */
export const windowBounds = (endMs: number, days: number): [number, number] => [endMs - Math.max(days, 1) * DAY_MS, endMs];

/** YTD day count for exclusive end `endMs` (= D + 1): Jan 1 .. D inclusive, in D's year. */
export const ytdDaysEndingAt = (endMs: number): number => {
  const last = new Date(endMs - DAY_MS);
  return Math.max(1, Math.round((endMs - Date.UTC(last.getUTCFullYear(), 0, 1)) / DAY_MS));
};

/** Window length for `rangeDays` ending at `endMs`: the YTD option (ytdDays(now)) maps to ytdDaysEndingAt. */
export const windowDaysAt = (rangeDays: number, endMs: number, now: Date = new Date()): number =>
  rangeDays === ytdDays(now) ? ytdDaysEndingAt(endMs) : rangeDays;

export type WindowBaseline<T> = { start: T; end: T; startTs: number; endTs: number; approximate: boolean };

/**
 * Stock points bracketing the window. A snapshot row dated D is end-of-D
 * state, so for the exclusive end `endMs` (= last day L + 1) and N days:
 *   end   = last row dated before endMs (ideally L),
 *   start = row dated endMs - (N + 1) days (= L - N, end-of-day before the window).
 * end - start is then the change over days [endMs - N, endMs), exactly the
 * days flowWindow sums. When no row sits exactly at start, pickBaseline's
 * tolerance picks the nearest one and the result is flagged `approximate`.
 * Legacy rows labelled with their run day are treated the same way.
 * When no row is dated L the end falls back to the last earlier row and the
 * result is flagged `approximate` (it does not cover the window's last day).
 * The YTD option (days === ytdDays(now)) uses ytdDaysEndingAt(endMs), the
 * same count flowWindow uses.
 */
export const pickWindowBaseline = <T>(
  points: readonly T[],
  endMs: number,
  days: number,
  getTs: (point: T) => number,
  now: Date = new Date(),
): WindowBaseline<T> | null => {
  const pts = points
    .map((p) => ({ p, ts: getTs(p) }))
    .filter((x) => Number.isFinite(x.ts) && x.ts < endMs)
    .sort((a, b) => a.ts - b.ts);
  if (pts.length === 0) return null;
  const last = pts[pts.length - 1];
  const lastDayMs = endMs - DAY_MS;
  const endIsD = last.ts >= lastDayMs;
  const n = Math.max(windowDaysAt(days, endMs, now), 1);
  const startMs = lastDayMs - n * DAY_MS;
  const exact = pts.find((x) => x.ts === startMs && x !== last);
  if (exact) return { start: exact.p, end: last.p, startTs: exact.ts, endTs: last.ts, approximate: !endIsD };
  const near = pickNearestBaseline(pts.filter((x) => x !== last), lastDayMs, n);
  if (near == null) return null;
  const nearTs = getTs(near);
  return { start: near, end: last.p, startTs: nearTs, endTs: last.ts, approximate: true };
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * cexBalance reclassifications dated inside (fromMs, toMs] whose summary names
 * this exchange (whole word; the changelog has no structured exchange field):
 * its wallet set changed, so its balance change mixes real movement with a
 * bookkeeping move. Unlike getEventsAffecting, backfillStatus is ignored: a
 * backfilled history still moved wallets in or out of the set mid-window.
 */
export const walletSetChangesFor = (
  changelog: ClassificationChangelog | null | undefined,
  exchange: string,
  fromMs: number,
  toMs: number,
): ClassificationEvent[] => {
  if (!changelog?.events?.length || !exchange) return [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return [];
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(exchange)}([^A-Za-z0-9]|$)`, "i");
  return changelog.events.filter((e) => {
    if (!e.affects?.metrics?.includes("cexBalance")) return false;
    const ms = Date.parse(e.date);
    return Number.isFinite(ms) && ms > fromMs && ms <= toMs && re.test(e.summary);
  });
};
