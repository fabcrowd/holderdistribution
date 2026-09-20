import { describe, expect, it } from "vitest";
import {
  RETAIL_THRESHOLD,
  computeChainMetrics,
  buildSummary,
  createEmptyMetrics,
} from "./holderMetrics.js";

describe("computeChainMetrics", () => {
  it("counts retail only for balances >= threshold", () => {
    const metrics = computeChainMetrics([
      { address: "0x1", balance: RETAIL_THRESHOLD },
      { address: "0x2", balance: RETAIL_THRESHOLD - 1 },
      { address: "0x3", balance: 50_000 },
    ]);
    expect(metrics.holderCount).toBe(3);
    expect(metrics.retail.count).toBe(2);
    expect(metrics.underThreshold.count).toBe(1);
    expect(metrics.totalBalance).toBe(RETAIL_THRESHOLD + (RETAIL_THRESHOLD - 1) + 50_000);
    expect(metrics.retail.balance).toBe(RETAIL_THRESHOLD + 50_000);
  });

  it("does not set retail.count to the full holder list length", () => {
    // Regression for resync-chain-holders.js which set retail.count = kept.length.
    const holders = Array.from({ length: 10 }, (_, i) => ({
      address: `0x${i}`,
      balance: i < 3 ? 500 : 5_000,
    }));
    const metrics = computeChainMetrics(holders);
    expect(metrics.holderCount).toBe(10);
    expect(metrics.retail.count).toBe(7);
    expect(metrics.retail.count).not.toBe(holders.length);
  });

  it("skips non-finite and non-positive balances", () => {
    const metrics = computeChainMetrics([
      { balance: 0 },
      { balance: -1 },
      { balance: NaN },
      { balance: 2_000 },
    ]);
    expect(metrics).toEqual({
      holderCount: 1,
      totalBalance: 2_000,
      retail: { count: 1, balance: 2_000 },
      underThreshold: { count: 0, balance: 0 },
    });
  });
});

describe("buildSummary", () => {
  it("derives summary from snapshot combined + chain metrics", () => {
    const snapshot = {
      generatedAt: "2026-08-07T12:00:00.000Z",
      source: { snapshotDate: "2026-08-07" },
      combined: {
        ...createEmptyMetrics(),
        holderCount: 100,
        totalBalance: 1_000_000,
        retail: { count: 80, balance: 900_000 },
      },
      chains: {
        ethereum: {
          metrics: {
            ...createEmptyMetrics(),
            holderCount: 60,
            retail: { count: 50, balance: 500_000 },
          },
        },
        polygon: {
          metrics: {
            ...createEmptyMetrics(),
            holderCount: 40,
            retail: { count: 30, balance: 400_000 },
          },
        },
      },
    };

    expect(buildSummary(snapshot)).toEqual({
      generatedAt: "2026-08-07T12:00:00.000Z",
      snapshotDate: "2026-08-07",
      combined: {
        holderCount: 100,
        retailHolderCount: 80,
        totalBalance: 1_000_000,
        holderCountWithStakers: 100,
      },
      chains: {
        ethereum: { holderCount: 60, retailHolderCount: 50 },
        polygon: { holderCount: 40, retailHolderCount: 30 },
      },
    });
  });
});
