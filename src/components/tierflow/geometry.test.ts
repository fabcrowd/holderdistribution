import { describe, expect, it } from "vitest";
import {
  TIER_BAR_MIN_FRACTION, TIER_COL_CENTER_X, TIER_COL_W, TIER_TILE_W, tierBarFraction, tileEdgeX,
} from "./geometry";

describe("tierBarFraction", () => {
  it("floors at the minimum sliver", () => {
    expect(tierBarFraction(0)).toBe(TIER_BAR_MIN_FRACTION);
    expect(tierBarFraction(1)).toBe(TIER_BAR_MIN_FRACTION);
    expect(tierBarFraction(-20)).toBe(TIER_BAR_MIN_FRACTION);
  });
  it("is proportional between the floor and full", () => {
    expect(tierBarFraction(50)).toBe(0.5);
    expect(tierBarFraction(100)).toBe(1);
  });
  it("clamps above 100", () => {
    expect(tierBarFraction(250)).toBe(1);
  });
  it("treats NaN and Infinity as the floor", () => {
    expect(tierBarFraction(NaN)).toBe(TIER_BAR_MIN_FRACTION);
    expect(tierBarFraction(Infinity)).toBe(TIER_BAR_MIN_FRACTION);
  });
});

describe("tileEdgeX", () => {
  it("places equal-width tiles symmetrically about the column centre", () => {
    expect(TIER_TILE_W).toBeLessThanOrEqual(TIER_COL_W);
    expect(tileEdgeX("left")).toBe(TIER_COL_CENTER_X - TIER_TILE_W / 2);
    expect(tileEdgeX("right") - tileEdgeX("left")).toBe(TIER_TILE_W);
  });
});
