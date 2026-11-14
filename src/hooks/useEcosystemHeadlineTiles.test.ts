import { describe, expect, it } from "vitest";
import { isFloatNoise } from "./useEcosystemHeadlineTiles";

describe("isFloatNoise", () => {
  it("treats a sub-token gap on a billion-token total as noise (the old < 1 rule)", () => {
    expect(isFloatNoise(1_000_000_000.38, 1_000_000_000)).toBe(true);
    expect(isFloatNoise(1_000_000_005, 1_000_000_000)).toBe(false);
  });
  it("scales down for a small token instead of swallowing real changes", () => {
    expect(isFloatNoise(500_000.5, 500_000)).toBe(false);
    expect(isFloatNoise(500_000, 500_000)).toBe(true);
  });
  it("is symmetric", () => {
    expect(isFloatNoise(1_000_000_000, 1_000_000_000.38)).toBe(true);
  });
});
