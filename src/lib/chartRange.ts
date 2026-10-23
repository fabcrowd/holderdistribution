import { ytdDays } from "./timeRange";

const DAY_MS = 86_400_000;

/**
 * Where a terminal chart should start for the page's range.
 *
 * YTD is a calendar range: it starts Jan 1 even when the feed lags "now"
 * (counting `ytdDays()` back from a lagging last point used to start a
 * "YTD" chart in early December of the previous year). Rolling ranges
 * (7D, 30D, 1Y…) count back from the series' own last point, so a lagging
 * feed still shows a full window instead of an empty chart.
 */
export const rangeStartMs = (rangeDays: number, lastMs: number, now: Date = new Date()): number => {
  if (rangeDays === ytdDays()) {
    const jan1 = new Date(now.getFullYear(), 0, 1).getTime();
    // A feed so stale its last point predates Jan 1 still gets a window.
    return lastMs >= jan1 ? jan1 : lastMs - rangeDays * DAY_MS;
  }
  return lastMs - Math.max(rangeDays, 1) * DAY_MS;
};

/** Rows on or after the range start (rows sorted ascending by time). */
export const clampToRange = <T,>(rows: T[], getT: (r: T) => number, rangeDays: number, now?: Date): T[] => {
  if (!rows.length) return rows;
  const from = rangeStartMs(rangeDays, getT(rows[rows.length - 1]), now);
  return rows.filter((r) => getT(r) >= from);
};

/**
 * Axis-length wallet-size labels ("10K–100K" → "10K"): the bucket's lower
 * bound, with the open-ended first/last buckets kept readable. The full
 * range stays in the tooltip and the chart's text alternative.
 */
export const shortBucketLabel = (rangeLabel: string): string => {
  const parts = rangeLabel.split(/[–-]/).map((x) => x.trim()).filter(Boolean);
  if (rangeLabel.trim().endsWith("+") || parts.length < 2) return rangeLabel.trim();
  if (parts[0] === "0" || parts[0] === "1") return `<${parts[1]}`;
  return parts[0];
};
