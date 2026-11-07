import { describe, expect, it } from "vitest";
import { flowWindow, flowWindowStartMs, flowOutOfRangeMessage, staleFeedNote } from "./flowWindow";
import { ytdDays } from "./timeRange";
import { DAY_MS, pickWindowBaseline, settledEndMs } from "./settledEnd";

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

describe("flowWindow with a shared settled end", () => {
  const rows = ["2026-10-29", "2026-10-30", "2026-11-04", "2026-11-05", "2026-11-06"].map((date) => ({ date }));
  const now = new Date("2026-11-06T12:00:00Z");

  it("covers [end - N, end): no asOf, end = today 00:00 excludes today's partial row", () => {
    const w = flowWindow(rows, 7, now, settledEndMs(null, now));
    expect(w.rows.map((r) => r.date)).toEqual(["2026-10-30", "2026-11-04", "2026-11-05"]);
  });

  it("includes the asOf day itself (asOf 2026-11-05, 1 day)", () => {
    const w = flowWindow(rows, 1, now, settledEndMs({ asOf: { date: "2026-11-05" } }, now));
    expect(w.rows.map((r) => r.date)).toEqual(["2026-11-05"]);
  });

  it("flow window and balance window cover the same days", () => {
    const daily = Array.from({ length: 12 }, (_, i) => ({ date: new Date(Date.parse("2026-10-26") + i * DAY_MS).toISOString().slice(0, 10) }));
    const endMs = settledEndMs({ asOf: { date: "2026-11-05" } }, now);
    for (const n of [1, 3, 7]) {
      const flowDays = flowWindow(daily, n, now, endMs).rows.map((r) => r.date);
      const b = pickWindowBaseline(daily, endMs, n, (p) => Date.parse(p.date));
      expect(b?.approximate).toBe(false);
      // Balance delta = end-of-end minus end-of-start, i.e. days (start, end].
      const balanceDays = daily.filter((r) => Date.parse(r.date) > b!.startTs && Date.parse(r.date) <= b!.endTs).map((r) => r.date);
      expect(flowDays).toEqual(balanceDays);
      expect(flowDays).toHaveLength(n);
      expect(flowDays[flowDays.length - 1]).toBe("2026-11-05");
    }
  });

  it("YTD: flow window and balance window use the same Jan 1 .. D day count", () => {
    const n = ytdDays(now);
    const daily = Array.from({ length: 320 }, (_, i) => ({ date: new Date(Date.parse("2025-12-25") + i * DAY_MS).toISOString().slice(0, 10) }));
    const endMs = settledEndMs({ asOf: { date: "2026-11-05" } }, now);
    const flowDays = flowWindow(daily, n, now, endMs).rows.map((r) => r.date);
    const b = pickWindowBaseline(daily, endMs, n, (p) => Date.parse(p.date), now);
    const balanceDays = daily.filter((r) => Date.parse(r.date) > b!.startTs && Date.parse(r.date) <= b!.endTs).map((r) => r.date);
    expect(flowDays[0]).toBe("2026-01-01");
    expect(flowDays).toEqual(balanceDays);
    expect(flowDays).toHaveLength(309);
  });

  it("YTD on Jan 1 is not empty: covers the previous year through Dec 31", () => {
    const jan1 = new Date("2026-01-01T10:00:00Z");
    const daily = ["2024-12-31", "2025-01-01", "2025-12-31", "2026-01-01"].map((date) => ({ date }));
    const w = flowWindow(daily, ytdDays(jan1), jan1, settledEndMs(null, jan1));
    expect(w.rows.map((r) => r.date)).toEqual(["2025-01-01", "2025-12-31"]);
  });
});
