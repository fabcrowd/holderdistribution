import { describe, expect, it } from "vitest";
import { flowWindow, flowWindowStartMs, flowOutOfRangeMessage, staleFeedNote } from "./flowWindow";
import { ytdDays } from "./timeRange";

const NOW = new Date("2026-11-05T12:00:00Z");
const rows = (...dates: string[]) => dates.map((date) => ({ date }));

describe("flowWindow", () => {
  it("anchors rolling windows to today (UTC), not the feed's last row", () => {
    expect(flowWindowStartMs(30, NOW)).toBe(Date.parse("2026-10-06T00:00:00Z"));
    const w = flowWindow(rows("2025-10-26", "2025-10-27"), 30, NOW);
    expect(w.rows).toEqual([]);
    expect(w.lastMs).toBe(Date.parse("2025-10-27"));
    expect(w.stale).toBe(true);
  });

  it("starts YTD on Jan 1 UTC", () => {
    const w = flowWindow(rows("2025-12-31", "2026-01-01", "2026-11-04"), ytdDays(NOW), NOW);
    expect(w.rows.map((r) => r.date)).toEqual(["2026-01-01", "2026-11-04"]);
    expect(w.stale).toBe(false);
  });

  it("flags stale only past 3 days", () => {
    expect(flowWindow(rows("2026-11-02"), 30, NOW).stale).toBe(false);
    expect(flowWindow(rows("2026-11-01"), 30, NOW).stale).toBe(true);
  });

  it("handles an empty feed", () => {
    expect(flowWindow([], 30, NOW)).toEqual({ rows: [], lastMs: null, stale: false });
  });

  it("formats the messages with a UTC date", () => {
    const ms = Date.parse("2025-10-27");
    expect(staleFeedNote(ms)).toBe("Data through Oct 27, 2025");
    expect(flowOutOfRangeMessage(ms)).toBe("No exchange-flow data in this range. Feed has data through Oct 27, 2025.");
  });
});
