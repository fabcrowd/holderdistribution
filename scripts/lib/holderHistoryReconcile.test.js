import { describe, expect, it } from "vitest";
import {
  LOWEST_DISTRIBUTION_LABEL,
  reconcileDistributionCounts,
  reconcileHistoryEntry,
} from "./holderHistoryReconcile.js";

const dist = (bottomCount) => [
  { label: "500M+", count: 1, totalBalance: 600_000_000 },
  { label: "250K-1M", count: 100, totalBalance: 50_000_000 },
  { label: LOWEST_DISTRIBUTION_LABEL, count: bottomCount, totalBalance: 10_000_000 },
];

describe("reconcileDistributionCounts", () => {
  it("is a no-op when holderCount already equals the distribution sum", () => {
    const rows = dist(50);
    const { distribution, gap, changed } = reconcileDistributionCounts(151, rows);
    expect(changed).toBe(false);
    expect(gap).toBe(0);
    expect(distribution).toBe(rows);
  });

  it("folds a positive dust gap into the lowest bucket", () => {
    const rows = dist(50);
    const { distribution, gap, changed } = reconcileDistributionCounts(151 + 7665, rows);
    expect(changed).toBe(true);
    expect(gap).toBe(7665);
    expect(distribution.find((r) => r.label === LOWEST_DISTRIBUTION_LABEL).count).toBe(50 + 7665);
    expect(distribution.reduce((s, r) => s + r.count, 0)).toBe(151 + 7665);
    // Other tiers untouched; balance left alone (dust << display scale).
    expect(distribution[0].count).toBe(1);
    expect(distribution[2].totalBalance).toBe(10_000_000);
  });

  it("does not mutate the input array", () => {
    const rows = dist(50);
    const before = rows[2].count;
    reconcileDistributionCounts(200, rows);
    expect(rows[2].count).toBe(before);
  });

  it("returns unchanged for missing distribution", () => {
    expect(reconcileDistributionCounts(100, null).changed).toBe(false);
    expect(reconcileDistributionCounts(100, []).changed).toBe(false);
  });
});

describe("reconcileHistoryEntry", () => {
  it("reconciles combined and per-chain distributions", () => {
    const entry = {
      date: "2026-01-18",
      combined: { holderCount: 200 },
      distribution: dist(50),
      chains: {
        ethereum: { holderCount: 120, distribution: dist(40) },
        polygon: { holderCount: 80, distribution: dist(30) },
      },
    };
    const out = reconcileHistoryEntry(entry);
    expect(out).not.toBe(entry);
    expect(out.distribution.reduce((s, r) => s + r.count, 0)).toBe(200);
    expect(out.chains.ethereum.distribution.reduce((s, r) => s + r.count, 0)).toBe(120);
    expect(out.chains.polygon.distribution.reduce((s, r) => s + r.count, 0)).toBe(80);
    // Original untouched
    expect(entry.distribution.reduce((s, r) => s + r.count, 0)).toBe(151);
  });

  it("returns the same object when nothing changes", () => {
    const entry = {
      date: "2026-08-08",
      combined: { holderCount: 151 },
      distribution: dist(50),
    };
    expect(reconcileHistoryEntry(entry)).toBe(entry);
  });
});
