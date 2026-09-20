import { describe, expect, it } from "vitest";
import { cellHasAttribution, dayHasAttribution, coverageFor, firstAttributedDate } from "./attributionCoverage.js";

// A day scanned before attribution existed: reconcileParts still gives it an
// `untracked` entry for whatever wallet flow it had, so its breakdown maps are
// non-empty even though nothing is actually attributed.
const preAttribution = (date) => ({
  date,
  tiers: { "1M-5M": { inflowsBySourceTier: { untracked: 3002984 }, movedByDestTier: { untracked: 5121057 } } },
});
const attributed = (date) => ({
  date,
  tiers: { "1M-5M": { inflowsBySourceTier: { "250K-1M": 500, untracked: 100 }, movedByDestTier: {} } },
});

describe("attribution coverage", () => {
  it("does not count an untracked-only day as attributed", () => {
    // The bug this guards: testing "breakdown map is non-empty" reported a
    // fully-untracked year as 100% attributed, which would have let the UI
    // claim complete coverage over a breakdown containing no real tiers.
    expect(dayHasAttribution(preAttribution("2026-01-01"))).toBe(false);
    expect(cellHasAttribution({ inflowsBySourceTier: { untracked: 1 }, movedByDestTier: { untracked: 2 } })).toBe(false);
  });

  it("counts a day that resolved flow to a real counterparty tier", () => {
    expect(dayHasAttribution(attributed("2026-08-03"))).toBe(true);
    expect(cellHasAttribution({ inflowsBySourceTier: { "250K-1M": 5 } })).toBe(true);
  });

  it("counts attribution on the outbound side too", () => {
    expect(cellHasAttribution({ movedByDestTier: { "5M-10M": 9 } })).toBe(true);
  });

  it("tolerates missing fields entirely", () => {
    expect(cellHasAttribution({})).toBe(false);
    expect(cellHasAttribution(undefined)).toBe(false);
    expect(dayHasAttribution({ date: "x" })).toBe(false);
  });

  it("reports coverage as a fraction of the window, not of everything", () => {
    const days = [
      preAttribution("2026-01-01"),
      preAttribution("2026-01-02"),
      attributed("2026-01-03"),
    ];
    expect(coverageFor(days, null)).toEqual({ attributedDays: 1, totalDays: 3 });
    // Window starting after the unattributed days is fully covered.
    expect(coverageFor(days, "2026-01-03")).toEqual({ attributedDays: 1, totalDays: 1 });
  });

  it("reports zero coverage for an entirely pre-attribution history", () => {
    const days = ["2026-01-01", "2026-01-02", "2026-01-03"].map(preAttribution);
    expect(coverageFor(days, null)).toEqual({ attributedDays: 0, totalDays: 3 });
    expect(firstAttributedDate(days)).toBeNull();
  });

  it("finds the first attributed date, not the first day with any flow", () => {
    const days = [preAttribution("2026-01-01"), attributed("2026-02-14"), attributed("2026-03-01")];
    expect(firstAttributedDate(days)).toBe("2026-02-14");
  });
});
