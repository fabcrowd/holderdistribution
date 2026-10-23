import { describe, expect, it } from "vitest";
import { clampToRange, rangeStartMs, shortBucketLabel } from "./chartRange";
import { ytdDays } from "./timeRange";

const DAY = 86_400_000;

describe("rangeStartMs", () => {
  it("starts YTD on Jan 1 even when the feed lags", () => {
    const now = new Date();
    const jan1 = new Date(now.getFullYear(), 0, 1).getTime();
    const lagging = now.getTime() - 21 * DAY;
    if (lagging >= jan1) expect(rangeStartMs(ytdDays(), lagging, now)).toBe(jan1);
  });
  it("counts rolling ranges back from the last point", () => {
    expect(rangeStartMs(7, 100 * DAY)).toBe(93 * DAY);
  });
});

describe("clampToRange", () => {
  it("drops points before the range start", () => {
    const rows = [1, 2, 5, 9, 10].map((d) => ({ t: d * DAY }));
    expect(clampToRange(rows, (r) => r.t, 5).map((r) => r.t / DAY)).toEqual([5, 9, 10]);
  });
  it("leaves empty input alone", () => {
    expect(clampToRange([], (r: { t: number }) => r.t, 5)).toEqual([]);
  });
});

describe("shortBucketLabel", () => {
  it("shortens closed ranges to their lower bound", () => {
    expect(["1–100", "100–1K", "1K–10K", "10K–100K", "100K–1M", "1M–10M", "10M+"].map(shortBucketLabel)).toEqual([
      "<100", "100", "1K", "10K", "100K", "1M", "10M+",
    ]);
  });
});
