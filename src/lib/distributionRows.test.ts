import { describe, expect, it } from "vitest";
import { mergeDistributionBaseline, summarizeTierGrowth } from "./distributionRows";

const base = [
  { label: "A", count: 10, totalBalance: 100, percent: 50 },
  { label: "B", count: 5, totalBalance: 100, percent: 50 },
];

describe("mergeDistributionBaseline", () => {
  it("returns snapshot rows untouched without history", () => {
    expect(mergeDistributionBaseline(base, null)).toBe(base);
  });
  it("re-bases previous values on the archive rows", () => {
    const rows = mergeDistributionBaseline(base, [
      { label: "A", count: 8, totalBalance: 150 },
      { label: "B", count: 6, totalBalance: 50 },
    ]);
    expect(rows[0]).toMatchObject({ previousCount: 8, previousTotalBalance: 150, previousPercent: 75 });
    expect(rows[1]).toMatchObject({ previousCount: 6, previousPercent: 25 });
  });
  it("nulls the baseline for tiers missing from history", () => {
    const rows = mergeDistributionBaseline(base, [{ label: "A", count: 8, totalBalance: 100 }]);
    expect(rows[1]).toMatchObject({ previousCount: null, previousTotalBalance: null, previousPercent: null });
  });
});

describe("summarizeTierGrowth", () => {
  it("counts growing tiers and nets wallets", () => {
    const rows = mergeDistributionBaseline(base, [
      { label: "A", count: 8, totalBalance: 1 },
      { label: "B", count: 6, totalBalance: 1 },
    ]);
    expect(summarizeTierGrowth(rows)).toEqual({ tiers: 2, grew: 1, netWallets: 1 });
  });
});
