import { describe, it, expect } from "vitest";
import { missingHistoryDates } from "./missingHistoryDates.js";

const rows = (...dates) => dates.map((date) => ({ date, settled: true }));

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

  it("treats a day whose row is explicitly unsettled as missing", () => {
    const entries = [...rows("2026-10-20", "2026-10-21"), { date: "2026-10-22", settled: false }];
    expect(missingHistoryDates(entries, "2026-10-24", 7)).toEqual(["2026-10-22", "2026-10-23"]);
  });

  it("treats unmarked rows newer than the newest settled row as missing, and older unmarked rows as present", () => {
    const entries = [
      { date: "2026-10-20", asOf: { settled: true } },
      { date: "2026-10-21" },
      { date: "2026-10-22" },
    ];
    expect(missingHistoryDates(entries, "2026-10-24", 7)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
  });

  it("with no settled row at all, every unmarked row in the window is missing", () => {
    const unmarked = [{ date: "2026-10-20" }, { date: "2026-10-21" }, { date: "2026-10-22" }];
    expect(missingHistoryDates(unmarked, "2026-10-24", 7)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
  });
});
