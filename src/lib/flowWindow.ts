import { ytdDays, ytdStartMs } from "./timeRange";
import { DAY_MS, utcMidnightMs as utcMidnight, windowBounds, windowDaysAt } from "./settledEnd";
/** A feed whose last day is older than this gets a visible "Data through" caveat. */
export const STALE_FEED_DAYS = 3;

const dateLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * Start of the selected window, anchored to today (UTC), never to the feed's own last row.
 * Known collision: YTD is detected as `rangeDays === ytdDays(now)`, so a fixed range whose
 * day count equals today's YTD count (e.g. 30D on Jan 30, 90D on ~Mar 31) is treated as YTD.
 * Harmless while both resolve to the same span; fixing it needs an explicit YTD flag from callers.
 */
export const flowWindowStartMs = (rangeDays: number, now: Date = new Date()): number =>
  rangeDays === ytdDays(now) ? ytdStartMs(now) : windowBounds(utcMidnight(now), rangeDays)[0];

export const formatFeedDate = (ms: number): string => dateLabel.format(new Date(ms));

export type FlowWindow<T> = {
  rows: T[];
  /** Last day the feed has, as epoch ms; null for an empty feed. */
  lastMs: number | null;
  /** The feed's last day is more than STALE_FEED_DAYS behind today. */
  stale: boolean;
};

/**
 * Rows of an ascending `{date}` feed that fall inside the window ending today (UTC).
 * With `endMs` (settledEndMs) the window is [endMs - rangeDays, endMs), the
 * same interval the balance table's pickWindowBaseline brackets.
 */
export const flowWindow = <T extends { date: string }>(
  rows: readonly T[],
  rangeDays: number,
  now: Date = new Date(),
  endMs?: number,
): FlowWindow<T> => {
  if (rows.length === 0) return { rows: [], lastMs: null, stale: false };
  const lastMs = Date.parse(rows[rows.length - 1].date);
  // YTD with a settled end counts Jan 1 .. D of D's year (windowDaysAt), the
  // same days pickWindowBaseline brackets; on Jan 1 that is the previous year, not an empty window.
  const from = endMs == null ? flowWindowStartMs(rangeDays, now) : windowBounds(endMs, windowDaysAt(rangeDays, endMs, now))[0];
  return {
    rows: rows.filter((r) => {
      const t = Date.parse(r.date);
      return t >= from && (endMs == null || t < endMs);
    }),
    lastMs,
    stale: utcMidnight(now) - lastMs > STALE_FEED_DAYS * DAY_MS,
  };
};

export const staleFeedNote = (lastMs: number): string => `Data through ${formatFeedDate(lastMs)}`;

export const flowOutOfRangeMessage = (lastMs: number): string =>
  `No exchange-flow data in this range. Feed has data through ${formatFeedDate(lastMs)}.`;
