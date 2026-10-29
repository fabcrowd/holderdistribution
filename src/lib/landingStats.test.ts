import { describe, expect, it } from "vitest";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { DASH, cardStats } from "./landingStats";

const snap = (holderCount: unknown, totalBalance: unknown, totalSupply: unknown) =>
  ({ totals: { totalSupply }, views: { combined: { metrics: { holderCount, totalBalance } } } }) as unknown as HolderLiteSnapshot;

describe("cardStats", () => {
  it("formats holder count and retail share of total supply", () => {
    expect(cardStats(snap(102130, 66_323_619_610.4, 100_000_000_000))).toEqual({ holders: "102,130", retailShare: "66.3%" });
  });
  it("counts unique wallets (overlap.uniqueCount), not the per-chain sum", () => {
    const s = {
      totals: { totalSupply: 100 },
      overlap: { uniqueCount: 99510 },
      views: { combined: { metrics: { holderCount: 102129, totalBalance: 50 } } },
    } as unknown as HolderLiteSnapshot;
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
