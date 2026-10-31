import { describe, expect, it } from "vitest";
import { RANGE_OPTIONS, rangeLabel, ytdDays } from "./timeRange";

describe("rangeLabel", () => {
  it("labels the calendar-YTD window YTD even when the option list was filtered away", () => {
    const withoutYtd = RANGE_OPTIONS.filter((o) => o.label !== "YTD");
    expect(rangeLabel(ytdDays(), withoutYtd)).toBe("YTD");
  });

  it("uses the option label when present and Nd for unknown windows", () => {
    expect(rangeLabel(30)).toBe("30D");
    expect(rangeLabel(365)).toBe("1Y");
    expect(rangeLabel(17)).toBe("17D");
  });
});
