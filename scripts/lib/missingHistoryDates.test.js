import { describe, it, expect } from "vitest";
import { missingHistoryDates } from "./missingHistoryDates.js";

const rows = (...dates) => dates.map((date) => ({ date }));

describe("missingHistoryDates", () => {
  it("lists days inside the window that have no row, oldest first", () => {
    const entries = rows("2026-10-20", "2026-10-21", "2026-10-23", "2026-10-25");
    expect(missingHistoryDates(entries, "2026-10-26", 7)).toEqual(["2026-10-22", "2026-10-24"]);
  });

  it("counts a trailing gap that runs up to yesterday", () => {
    const entries = rows("2026-10-20", "2026-10-21");
    expect(missingHistoryDates(entries, "2026-10-24", 7)).toEqual(["2026-10-22", "2026-10-23"]);
  });

  it("ignores days before the first row, which are pre-history and cannot be rebuilt", () => {
    const entries = rows("2026-11-05");
    expect(missingHistoryDates(entries, "2026-11-05", 14)).toEqual([]);
  });

  it("returns nothing when every day since the first row is present", () => {
    const entries = rows("2026-11-03", "2026-11-04", "2026-11-05");
    expect(missingHistoryDates(entries, "2026-11-06", 14)).toEqual([]);
  });

  it("does not count today, which the daily refresh owns", () => {
    const entries = rows("2026-11-04");
    expect(missingHistoryDates(entries, "2026-11-05", 7)).toEqual([]);
  });
});
