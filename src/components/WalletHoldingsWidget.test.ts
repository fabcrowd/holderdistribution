import { describe, expect, it } from "vitest";
import { defaultHolderTiers } from "@/lib/holderTiers";
import { logMidFor, shownConcentrationBuckets } from "./WalletHoldingsWidget";

const TEL_MIDS: Record<string, number> = {
  "1–100": 10,
  "100–1K": 316,
  "1K–10K": 3162,
  "10K–100K": 31623,
  "100K–1M": 316228,
  "1M–10M": 3162278,
  "10M+": 31622776,
};

describe("shownConcentrationBuckets", () => {
  const buckets = [10, 25, 50, 100, 250, 500, 1000];
  const full = Object.fromEntries(buckets.map((n) => [String(n), n * 1000]));

  it("shows every configured bucket for a large token", () => {
    expect(shownConcentrationBuckets(buckets, full, 50_000)).toEqual(buckets);
  });
  it("hides buckets at or above the holder count for a 300-holder token (no Top 500/1000)", () => {
    expect(shownConcentrationBuckets(buckets, full, 300)).toEqual([10, 25, 50, 100, 250]);
    expect(shownConcentrationBuckets(buckets, full, 250)).toEqual([10, 25, 50, 100]);
  });
  it("hides a bucket the feed has no data for instead of showing 0", () => {
    const { "25": _omit, ...rest } = full;
    expect(shownConcentrationBuckets(buckets, rest, 50_000)).not.toContain(25);
  });
  it("keeps a real zero value and ignores an unknown holder count", () => {
    expect(shownConcentrationBuckets([10], { "10": 0 }, null)).toEqual([10]);
    expect(shownConcentrationBuckets([10], { "10": 0 }, 0)).toEqual([10]);
  });
  it("follows the project's own bucket list", () => {
    expect(shownConcentrationBuckets([5, 20], { "5": 1, "20": 2, "10": 3 }, 1000)).toEqual([5, 20]);
  });
});

describe("logMidFor", () => {
  const ranges = defaultHolderTiers().balanceRanges;
  it("reproduces TEL's old hand-typed log midpoints from min/max alone", () => {
    for (const r of ranges) {
      expect(logMidFor(r.label, ranges)).toBeCloseTo(Math.log(TEL_MIDS[r.label]!), 6);
    }
  });
  it("does not depend on the label text", () => {
    const renamed = [{ label: "tiny", min: 1, max: 100 }, { label: "big", min: 100, max: Number.POSITIVE_INFINITY }];
    expect(logMidFor("tiny", renamed)).toBeCloseTo(Math.log(10), 9);
    expect(logMidFor("big", renamed)).toBeCloseTo(Math.log(316), 6);
    expect(logMidFor("missing", renamed)).toBe(0);
  });
});
