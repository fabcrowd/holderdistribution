import { describe, expect, it } from "vitest";
import {
  SIDE_COUNT, SIDE_H, TIER_BAR_MIN_FRACTION, TIER_COL_CENTER_X, TIER_COL_W, TIER_H, TIER_TILE_W,
  canvasHeight, rowTop, sideTop, tierBarFraction, tileEdgeX,
} from "./geometry";

describe("canvas and side-tile layout by tier count", () => {
  it.each([2, 3, 10, 14])("%i tiers: nothing negative, nothing clipped, no overlap", (n) => {
    const h = canvasHeight(n);
    for (let j = 0; j < SIDE_COUNT; j++) {
      expect(sideTop(j, h)).toBeGreaterThanOrEqual(0);
      expect(sideTop(j, h) + SIDE_H).toBeLessThanOrEqual(h);
      if (j > 0) expect(sideTop(j, h)).toBeGreaterThanOrEqual(sideTop(j - 1, h) + SIDE_H);
    }
    for (let i = 0; i < n; i++) {
      expect(rowTop(i)).toBeGreaterThanOrEqual(0);
      expect(rowTop(i) + TIER_H).toBeLessThanOrEqual(h);
      if (i > 0) expect(rowTop(i)).toBeGreaterThanOrEqual(rowTop(i - 1) + TIER_H);
    }
  });
  it("lays 10 tiers out exactly as before", () => {
    expect(canvasHeight(10)).toBe(682);
    expect([0, 1, 2, 3].map((j) => sideTop(j, 682))).toEqual([211, 279, 347, 415]);
  });
  it("grows with tier count beyond 10", () => {
    expect(canvasHeight(14)).toBe(682 + 4 * 66);
  });
  it("clamps sideTop at 0 for a canvas shorter than the stack", () => {
    expect(sideTop(0, 100)).toBe(0);
  });
});

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
