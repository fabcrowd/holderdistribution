import { describe, expect, it } from "vitest";
import { ATH_THIN_HISTORY_DAYS, athHistoryNote, historyDays } from "./athNote";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 6);

describe("historyDays", () => {
  it("counts inclusive UTC calendar days across the series", () => {
    expect(historyDays([T0, T0 + 4 * DAY])).toBe(5);
    expect(historyDays([T0 + 3 * DAY, T0, T0 + DAY])).toBe(4);
  });
  it("is 1 for a single point and 0 for none or non-finite input", () => {
    expect(historyDays([T0])).toBe(1);
    expect(historyDays([])).toBe(0);
    expect(historyDays([Number.NaN])).toBe(0);
  });
});

describe("athHistoryNote", () => {
  it("states the real day count while history is under the threshold", () => {
    expect(athHistoryNote(5)).toBe("Based on 5 days of data");
    expect(athHistoryNote(1)).toBe("Based on 1 day of data");
    expect(athHistoryNote(ATH_THIN_HISTORY_DAYS - 1)).toBe(`Based on ${ATH_THIN_HISTORY_DAYS - 1} days of data`);
  });
  it("is null at or past the threshold or with no data", () => {
    expect(athHistoryNote(ATH_THIN_HISTORY_DAYS)).toBeNull();
    expect(athHistoryNote(304)).toBeNull();
    expect(athHistoryNote(0)).toBeNull();
  });
});
