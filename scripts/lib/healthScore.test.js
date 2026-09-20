import { describe, expect, it } from "vitest";
import {
  buildHealthScoreFromArtifacts,
  computeHealthScore,
  scoreFromDexRatio,
  scoreFromGini,
  scoreFromHolderGrowth,
} from "./healthScore.js";

describe("healthScore", () => {
  it("maps lower Gini to a higher distribution score", () => {
    expect(scoreFromGini(0.5)).toBe(100);
    expect(scoreFromGini(1)).toBe(0);
    expect(scoreFromGini(0.75)).toBe(50);
  });

  it("scores DEX liquidity relative to the 30d average", () => {
    expect(scoreFromDexRatio(100, 100)).toBe(50);
    expect(scoreFromDexRatio(200, 100)).toBe(100);
    expect(scoreFromDexRatio(0, 100)).toBe(0);
  });

  it("scores holder growth around a 50 neutral", () => {
    expect(scoreFromHolderGrowth(110, 100)).toBe(100);
    expect(scoreFromHolderGrowth(100, 100)).toBe(50);
    expect(scoreFromHolderGrowth(90, 100)).toBe(0);
  });

  it("weights components into a single 0–100 score", () => {
    const result = computeHealthScore({
      gini: 0.75,
      dexLiquidity: 100,
      dexLiquidityAvg30: 100,
      recentAbsHolderDelta: 10,
      avgAbsHolderDelta30: 10,
      holderCount: 100,
      holderCountAgo30: 100,
    });
    expect(result.score).toBe(50);
    expect(result.label).toBe("stability");
  });

  it("builds from lite + history artifacts", () => {
    const lite = {
      views: {
        combined: {
          balanceStats: { gini: 0.75 },
          metrics: { holderCount: 1000 },
        },
      },
    };
    const history = [];
    for (let i = 0; i <= 30; i++) {
      history.push({
        date: `2026-01-${String(i + 1).padStart(2, "0")}`,
        combined: {
          holderCount: 970 + i,
          dexLiquidity: 1_000_000_000,
        },
      });
    }
    const out = buildHealthScoreFromArtifacts(lite, history, 30);
    expect(out.score).toBeTypeOf("number");
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
    expect(["accumulation", "stability", "distribution"]).toContain(out.label);
    expect(out.inputs.gini).toBe(0.75);
  });
});
