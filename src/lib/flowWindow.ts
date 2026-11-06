import { ytdDays, ytdStartMs } from "./timeRange";

const DAY_MS = 86_400_000;
/** A feed whose last day is older than this gets a visible "Data through" caveat. */
export const STALE_FEED_DAYS = 3;

const dateLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

const utcMidnight = (now: Date): number => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** Start of the selected window, anchored to today (UTC), never to the feed's own last row. */
export const flowWindowStartMs = (rangeDays: number, now: Date = new Date()): number =>
  rangeDays === ytdDays(now) ? ytdStartMs(now) : utcMidnight(now) - Math.max(rangeDays, 1) * DAY_MS;

export const formatFeedDate = (ms: number): string => dateLabel.format(new Date(ms));

export type FlowWindow<T> = {
  rows: T[];
  /** Last day the feed has, as epoch ms; null for an empty feed. */
  lastMs: number | null;
  /** The feed's last day is more than STALE_FEED_DAYS behind today. */
  stale: boolean;
};

/** Rows of an ascending `{date}` feed that fall inside the window ending today (UTC). */
export const flowWindow = <T extends { date: string }>(rows: readonly T[], rangeDays: number, now: Date = new Date()): FlowWindow<T> => {
  if (rows.length === 0) return { rows: [], lastMs: null, stale: false };
  const lastMs = Date.parse(rows[rows.length - 1].date);
  const from = flowWindowStartMs(rangeDays, now);
  return {
    rows: rows.filter((r) => Date.parse(r.date) >= from),
    lastMs,
    stale: utcMidnight(now) - lastMs > STALE_FEED_DAYS * DAY_MS,
  };
};

export const staleFeedNote = (lastMs: number): string => `Data through ${formatFeedDate(lastMs)}`;

export const flowOutOfRangeMessage = (lastMs: number): string =>
  `No exchange-flow data in this range. Feed has data through ${formatFeedDate(lastMs)}.`;
