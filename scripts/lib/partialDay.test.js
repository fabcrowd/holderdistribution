import { describe, expect, it } from "vitest";
import { markPartialDay, partialDateFor, utcDate } from "./partialDay.js";

const NOW = new Date("2026-10-28T22:59:00Z");

describe("partialDay", () => {
  it("reads the UTC date, not the local one", () => {
    expect(utcDate(new Date("2026-10-28T23:30:00-05:00"))).toBe("2026-10-29");
  });

  it("flags only the final row, and only when its day is today", () => {
    const rows = [{ date: "2026-10-26", in: 1 }, { date: "2026-10-27", in: 2 }, { date: "2026-10-28", in: 3 }];
    const out = markPartialDay(rows, NOW);
    expect(out.map((r) => r.partial)).toEqual([undefined, undefined, true]);
    expect(out[2]).toEqual({ date: "2026-10-28", in: 3, partial: true });
  });

  it("leaves a finished final day unmarked and clears a stale flag", () => {
    const rows = [{ date: "2026-10-27", in: 2, partial: true }];
    expect(markPartialDay(rows, NOW)).toEqual([{ date: "2026-10-27", in: 2 }]);
  });

  it("does not mutate its input and handles an empty feed", () => {
    const rows = [{ date: "2026-10-28", in: 3 }];
    markPartialDay(rows, NOW);
    expect(rows[0]).toEqual({ date: "2026-10-28", in: 3 });
    expect(markPartialDay([], NOW)).toEqual([]);
  });

  it("partialDateFor returns the date only while in progress", () => {
    expect(partialDateFor("2026-10-28", NOW)).toBe("2026-10-28");
    expect(partialDateFor("2026-10-27", NOW)).toBeNull();
    expect(partialDateFor(undefined, NOW)).toBeNull();
    expect(partialDateFor(null, NOW)).toBeNull();
  });
});
