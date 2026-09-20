import { describe, expect, it } from "vitest";
import {
  isDex,
  isDisplayableTrust,
  isMajorCex,
  marketsHaveTrustScores,
  shouldKeepTicker,
} from "./telMarketsClassify.js";

describe("telMarketsClassify", () => {
  it("treats major CEX names as never-DEX", () => {
    expect(isMajorCex("kucoin", "KuCoin")).toBe(true);
    expect(isDex("kucoin", "KuCoin")).toBe(false);
  });

  it("recognizes Uniswap / Aerodrome / QuickSwap as DEX", () => {
    expect(isDex("uniswap_v3", "Uniswap V3 (Base)")).toBe(true);
    expect(isDex("aerodrome-base", "Aerodrome (Base)")).toBe(true);
    expect(isDex("quickswap", "Quickswap (Polygon)")).toBe(true);
  });

  it("keeps CEX with green trust", () => {
    expect(
      shouldKeepTicker({
        marketId: "kucoin",
        marketName: "KuCoin",
        volume: 1000,
        price: 0.01,
        trustScore: "green",
      }),
    ).toBe(true);
  });

  it("keeps major CEX even without trust score", () => {
    expect(
      shouldKeepTicker({
        marketId: "mexc",
        marketName: "MEXC",
        volume: 500,
        price: 0.01,
        trustScore: null,
      }),
    ).toBe(true);
  });

  it("keeps DEX with volume even when trust is unknown", () => {
    expect(
      shouldKeepTicker({
        marketId: "uniswap_v3_base",
        marketName: "Uniswap V3 (Base)",
        volume: 12000,
        price: 0.005,
        trustScore: null,
      }),
    ).toBe(true);
  });

  it("drops zero-volume tickers", () => {
    expect(
      shouldKeepTicker({
        marketId: "uniswap_v3",
        marketName: "Uniswap V3",
        volume: 0,
        price: 0.01,
        trustScore: "green",
      }),
    ).toBe(false);
  });

  it("drops unknown venues with no trust and no volume path", () => {
    expect(
      shouldKeepTicker({
        marketId: "obscure_otc",
        marketName: "Obscure OTC",
        volume: 100,
        price: 0.01,
        trustScore: null,
      }),
    ).toBe(false);
  });

  it("detects displayable trust scores for the UI column", () => {
    expect(isDisplayableTrust("green")).toBe(true);
    expect(isDisplayableTrust("unknown")).toBe(false);
    expect(
      marketsHaveTrustScores([
        { trust_score: "unknown" },
        { trust_score: "yellow" },
      ]),
    ).toBe(true);
    expect(marketsHaveTrustScores([{ trust_score: "unknown" }])).toBe(false);
  });
});
