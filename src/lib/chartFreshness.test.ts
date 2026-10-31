import { describe, expect, it } from "vitest";
import { chartLagsPage } from "./chartFreshness";

const PAGE = "2026-10-31T12:00:00Z";

describe("chartLagsPage", () => {
  it("flags a chart whose data trails the page by more than the fresh window", () => {
    expect(chartLagsPage("2026-10-29T12:00:00Z", PAGE)).toBe(true);
  });

  it("does not flag a chart one daily run behind the page", () => {
    expect(chartLagsPage("2026-10-30T12:00:00Z", PAGE)).toBe(false);
  });

  it("does not flag a chart at or ahead of the page", () => {
    expect(chartLagsPage(PAGE, PAGE)).toBe(false);
    expect(chartLagsPage("2026-11-01T12:00:00Z", PAGE)).toBe(false);
  });

  it("needs both stamps to be valid dates", () => {
    expect(chartLagsPage(null, PAGE)).toBe(false);
    expect(chartLagsPage("2026-10-29T12:00:00Z", undefined)).toBe(false);
    expect(chartLagsPage("not a date", PAGE)).toBe(false);
  });
});
