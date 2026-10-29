import { describe, expect, it } from "vitest";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { countsWalletsPerChain, retailWalletsInfo, uniqueWalletCount } from "./holderCounts";

describe("uniqueWalletCount", () => {
  it("reads overlap.uniqueCount, never metrics.holderCount", () => {
    const snap = { overlap: { uniqueCount: 99510 }, views: { combined: { metrics: { holderCount: 102129 } } } } as unknown as HolderLiteSnapshot;
    expect(uniqueWalletCount(snap)).toBe(99510);
  });
  it("is null when the snapshot has no overlap block or a bad value", () => {
    expect(uniqueWalletCount(undefined)).toBeNull();
    expect(uniqueWalletCount({ overlap: null } as unknown as HolderLiteSnapshot)).toBeNull();
    expect(uniqueWalletCount({ overlap: { uniqueCount: "x" } } as unknown as HolderLiteSnapshot)).toBeNull();
  });
});

describe("countsWalletsPerChain", () => {
  it("is true only when de-duplication shrinks the count", () => {
    expect(countsWalletsPerChain(102129, 99510)).toBe(true);
    expect(countsWalletsPerChain(114763, 114763)).toBe(false);
    expect(countsWalletsPerChain(null, 5)).toBe(false);
    expect(countsWalletsPerChain(5, null)).toBe(false);
  });
});

describe("retailWalletsInfo", () => {
  it("states per-chain counting and the unique figure on a multi-chain token", () => {
    const text = retailWalletsInfo({ ticker: "TEL", chains: "Ethereum, Polygon and Base", walletCount: 102129, uniqueWallets: 99510 });
    expect(text).toContain("counted separately");
    expect(text).toContain("99,510 unique wallets");
    expect(text).toContain("TEL");
  });
  it("keeps the plain definition on a single-chain token", () => {
    const text = retailWalletsInfo({ ticker: "ZBCN", chains: "Solana", walletCount: 114763, uniqueWallets: 114763 });
    expect(text).toContain("distinct on-chain wallets holding >0 ZBCN across Solana");
    expect(text).not.toContain("unique wallets");
  });
});
