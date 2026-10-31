const DAY_MS = 86_400_000;

/**
 * Jan 1 00:00 UTC of `now`'s UTC year. Every feed is dated in UTC (snapshot
 * `generatedAt`, daily history rows), so calendar ranges start on a UTC
 * boundary too — a reader in UTC+14 or UTC−10 sees the same YTD window and
 * the same rows as everyone else instead of one shifted by their offset.
 */
export const ytdStartMs = (now: Date = new Date()): number => Date.UTC(now.getUTCFullYear(), 0, 1);

export const ytdDays = (now: Date = new Date()) => Math.max(1, Math.ceil((now.getTime() - ytdStartMs(now)) / DAY_MS));

export const RANGE_OPTIONS = [
  { label: "1D", days: 1 },
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "YTD", days: ytdDays() },
  { label: "1Y", days: 365 },
];

type RangeOption = { label: string; days: number };

/**
 * Display label for a range. The picker hides options the archive cannot back
 * (a young token has no YTD baseline), but the page still defaults to the YTD
 * window; it must read "YTD" like every other token, not "304D".
 */
export const rangeLabel = (days: number, options: readonly RangeOption[] = RANGE_OPTIONS): string =>
  options.find((o) => o.days === days)?.label ?? (days === ytdDays() ? "YTD" : `${days}D`);
