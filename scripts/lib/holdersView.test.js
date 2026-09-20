import { describe, expect, it } from "vitest";
import {
  BALANCE_RANGES,
  DISTRIBUTION_RANGES,
  buildBalanceStats,
  buildDistributionRows,
} from "./holdersView.js";

// MIN_TEL_RAW is 1 RAW unit and TEL has 2 decimals, so the smallest balance the
// pipeline records is 0.01 TEL. Sub-1-TEL dust wallets are deliberately
// excluded from every bucket/breakdown (BALANCE_RANGES/DISTRIBUTION_RANGES
// floor at 1 TEL) while metrics.holderCount and balanceStats.count still
// count them — see lessons.md "Sub-1-TEL Dust Wallets Are Deliberately
// Excluded From Buckets, Not Counts". That's an intentional, documented gap,
// not the reconciliation bug an earlier floor=0 version of this file fixed.
const dustHolder = (address, balance) => ({ address, balance, totalBalance: balance, stakedBalance: 0 });

describe("holder bucket floors", () => {
  it("floors the smallest bucket at 1 TEL, excluding sub-1-TEL dust", () => {
    expect(BALANCE_RANGES[0].min).toBe(1);
    expect(DISTRIBUTION_RANGES[DISTRIBUTION_RANGES.length - 1].min).toBe(1);
  });

  it("keeps the bottom tier's label string stable — it is a join key", () => {
    // holder-transitions.json's migration matrix and tier-outflows.json are
    // both keyed by this exact string. Renaming it here silently breaks those
    // joins until every dataset is regenerated; the UI renames it for display
    // only (see tierDisplayLabel in components/tierflow/geometry.ts).
    expect(DISTRIBUTION_RANGES[DISTRIBUTION_RANGES.length - 1].label).toBe("1-250K");
  });

  it("counts every holder (including dust) in balanceStats.count, independent of bucket floors", () => {
    const holders = [
      dustHolder("0x01", 0.01),
      dustHolder("0x02", 0.5),
      dustHolder("0x03", 0.99),
      dustHolder("0x04", 1),
      dustHolder("0x05", 250),
      dustHolder("0x06", 1_000_000),
      dustHolder("0x07", 600_000_000),
    ];

    const stats = buildBalanceStats(holders);
    expect(stats.count).toBe(holders.length);
  });

  it("excludes sub-1-TEL dust from the bucket breakdown, by design", () => {
    const holders = [
      dustHolder("0x01", 0.01),
      dustHolder("0x02", 0.5),
      dustHolder("0x03", 0.99),
      dustHolder("0x04", 1),
      dustHolder("0x05", 250),
      dustHolder("0x06", 1_000_000),
      dustHolder("0x07", 600_000_000),
    ];
    const dustCount = holders.filter((h) => h.balance < 1).length;

    const stats = buildBalanceStats(holders);
    const rows = buildDistributionRows(holders, 1, [], 0);
    const distributionCount = rows.reduce((sum, row) => sum + row.count, 0);

    // The bucket breakdowns intentionally sum to fewer holders than the
    // headline count — exactly the dust-wallet count, no more, no less.
    expect(stats.count - stats.distributionBuckets.reduce((s, b) => s + b.count, 0)).toBe(dustCount);
    expect(stats.count - distributionCount).toBe(dustCount);
  });

  it("does not put sub-1-TEL dust in the bottom tier — dust is absent from every bucket", () => {
    const rows = buildDistributionRows([dustHolder("0x01", 0.01), dustHolder("0x02", 0.5), dustHolder("0x03", 1)], 1, [], 0);
    const bottom = rows.find((row) => row.label === "1-250K");
    // Only the >=1 TEL holder counts; the two dust wallets are excluded.
    expect(bottom?.count).toBe(1);
  });
});
