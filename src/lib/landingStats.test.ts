import { describe, expect, it } from "vitest";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { DASH, boardTotals, cardStats, percentWidth } from "./landingStats";

const snap = (holderCount: unknown, totalBalance: unknown, totalSupply: unknown) =>
  ({ totals: { totalSupply }, views: { combined: { metrics: { holderCount, totalBalance } } } }) as unknown as HolderLiteSnapshot;

describe("boardTotals", () => {
  it("counts tokens, sums retail wallets with the card's count logic, and counts unique chains", () => {
    expect(
      boardTotals([snap(102130, 1, 1), snap(4870, 1, 1)], [["ethereum", "base"], ["base", "solana"]]),
    ).toEqual({ tokens: 2, wallets: "107,000", chains: 3 });
  });
  it("falls back to overlap.uniqueCount per token, like cardStats", () => {
    const withUnique = { overlap: { uniqueCount: 99510 }, views: { combined: { metrics: {} } } } as unknown as HolderLiteSnapshot;
    expect(boardTotals([withUnique, snap(10, 1, 1)], []).wallets).toBe("99,520");
  });
  it("shows a dash for wallets when any snapshot is missing, null or has no count", () => {
    expect(boardTotals([snap(5, 1, 1), null], []).wallets).toBe(DASH);
    expect(boardTotals([snap(5, 1, 1), undefined], []).wallets).toBe(DASH);
    expect(boardTotals([snap(undefined, 1, 1), snap(5, 1, 1)], []).wallets).toBe(DASH);
  });
  it("still counts tokens and chains when wallets are unknown", () => {
    expect(boardTotals([null, null], [["tel"], ["tel", "eth"]])).toEqual({ tokens: 2, wallets: DASH, chains: 2 });
  });
  it("is zero for an empty board", () => {
    expect(boardTotals([], [])).toEqual({ tokens: 0, wallets: "0", chains: 0 });
  });
});

describe("percentWidth", () => {
  it("parses a percent string into a number", () => {
    expect(percentWidth("66.6%")).toBe(66.6);
  });
  it("clamps to 0..100", () => {
    expect(percentWidth("135%")).toBe(100);
    expect(percentWidth("-3%")).toBe(0);
  });
  it("returns null for dashes, null, undefined and non-numeric text", () => {
    expect(percentWidth("—")).toBeNull();
    expect(percentWidth(null)).toBeNull();
    expect(percentWidth(undefined)).toBeNull();
    expect(percentWidth("12abc%")).toBeNull();
  });
});

describe("cardStats", () => {
  it("formats holder count and retail share of total supply", () => {
    expect(cardStats(snap(102130, 66_323_619_610.4, 100_000_000_000))).toEqual({ holders: "102,130", retailShare: "66.3%" });
  });
  it("reads the retail wallet count (metrics.holderCount), not the de-duplicated overlap count", () => {
    const s = {
      totals: { totalSupply: 100 },
      overlap: { uniqueCount: 99510 },
      views: { combined: { metrics: { holderCount: 102125, totalBalance: 50 } } },
    } as unknown as HolderLiteSnapshot;
    expect(cardStats(s).holders).toBe("102,125");
  });
  it("falls back to overlap.uniqueCount when holderCount is missing", () => {
    const s = { totals: { totalSupply: 100 }, overlap: { uniqueCount: 99510 }, views: { combined: { metrics: {} } } } as unknown as HolderLiteSnapshot;
    expect(cardStats(s).holders).toBe("99,510");
  });
  it("shows a dash per missing stat, independently", () => {
    expect(cardStats(undefined)).toEqual({ holders: DASH, retailShare: DASH });
    expect(cardStats(null)).toEqual({ holders: DASH, retailShare: DASH });
    expect(cardStats(snap(5, undefined, 100))).toEqual({ holders: "5", retailShare: DASH });
    expect(cardStats(snap(undefined, 50, 100))).toEqual({ holders: DASH, retailShare: "50.0%" });
    expect(cardStats(snap(5, 50, 0))).toEqual({ holders: "5", retailShare: DASH });
    expect(cardStats({} as HolderLiteSnapshot)).toEqual({ holders: DASH, retailShare: DASH });
  });
});
