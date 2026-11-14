import { describe, expect, it } from "vitest";
import { compact, deriveHolderTiers, floorToLadder, MAX_TIER_SHARE } from "./deriveHolderTiers.js";
import { loadDefaultHolderTiersRaw, normalizeHolderTiers } from "./holderTiers.js";

/** Deterministic long-tailed population: balance falls off as a power of rank. */
const population = (n, top, power = 1.6) => Array.from({ length: n }, (_, i) => Math.max(1, top / (i + 1) ** power));

describe("floorToLadder and compact", () => {
  it("rounds down to 1 / 2.5 / 5 x 10^k", () => {
    expect(floorToLadder(1)).toBe(1);
    expect(floorToLadder(2.4)).toBe(1);
    expect(floorToLadder(2.5)).toBe(2.5);
    expect(floorToLadder(49_999)).toBe(25_000);
    expect(floorToLadder(130_000_000)).toBe(100_000_000);
  });
  it("labels compactly", () => {
    expect(compact(2_500)).toBe("2.5K");
    expect(compact(250_000_000)).toBe("250M");
    expect(compact(5_000_000_000)).toBe("5B");
    expect(compact(7)).toBe("7");
  });
});

describe("deriveHolderTiers", () => {
  it("returns tiers that pass the registry rules: ordered, contiguous, open at the top, starting at 1", () => {
    const { distributionTiers, balanceRanges } = deriveHolderTiers(population(200_000, 5e9));
    const t = normalizeHolderTiers({ megaHolderThreshold: 1e12, distributionTiers, balanceRanges }).distributionTiers;
    expect(t[0].max).toBe(Number.POSITIVE_INFINITY);
    expect(t.at(-1).min).toBe(1);
    for (let i = 1; i < t.length; i += 1) expect(t[i].max).toBe(t[i - 1].min);
    expect(new Set(t.map((x) => x.label)).size).toBe(t.length);
    expect(balanceRanges[0].min).toBe(1);
    expect(balanceRanges.at(-1).max).toBeNull();
    expect(balanceRanges.length).toBeLessThanOrEqual(8);
  });

  it("spaces Wallet Holdings ranges by the same number of decades, ending open at the top", () => {
    for (const pop of [population(200_000, 5e9), population(5_000, 1e15, 3), population(100, 50)]) {
      const { balanceRanges } = deriveHolderTiers(pop);
      const ratios = balanceRanges.slice(0, -1).map((r) => r.max / r.min);
      expect(new Set(ratios).size).toBeLessThanOrEqual(1);
      expect(balanceRanges.at(-1).max).toBeNull();
      expect(balanceRanges.length).toBeLessThanOrEqual(8);
    }
  });

  it("keeps every tier under the one-tier share limit", () => {
    for (const pop of [population(200_000, 5e9), population(681_000, 3e9, 1.2), population(115_000, 2e10, 2)]) {
      expect(deriveHolderTiers(pop).largestTierShare).toBeLessThanOrEqual(MAX_TIER_SHARE);
    }
  });

  it("comes from the project's own balances, not from TEL's tiers", () => {
    const telEdges = loadDefaultHolderTiersRaw().distributionTiers.map((t) => t.min);
    const small = deriveHolderTiers(population(50_000, 1e6)).distributionTiers.map((t) => t.min);
    const large = deriveHolderTiers(population(50_000, 1e10)).distributionTiers.map((t) => t.min);
    expect(small).not.toEqual(large);
    expect(small).not.toEqual(telEdges);
    expect(large).not.toEqual(telEdges);
  });

  it("ignores order and balances below 1, and is deterministic", () => {
    const pop = population(10_000, 1e8);
    const shuffled = [...pop].reverse().concat([0, 0.5, Number.NaN]);
    expect(deriveHolderTiers(shuffled)).toEqual(deriveHolderTiers(pop));
  });

  it("sizes the mega-holder threshold at 1/5 of the supply target (TEL 100B -> 20B, ONDO 10B -> 2B)", () => {
    const pop = population(20_000, 1e8);
    expect(deriveHolderTiers(pop, { supplyTarget: 100e9 }).megaHolderThreshold).toBe(20e9);
    expect(deriveHolderTiers(pop, { supplyTarget: 10e9 }).megaHolderThreshold).toBe(2e9);
    expect(deriveHolderTiers(pop).megaHolderThreshold).toBeNull();
    expect(() => deriveHolderTiers(pop, { supplyTarget: 0 })).toThrow(/supplyTarget/);
  });

  it("sets retail to the lower bound of the second-lowest tier and passes registry validation", () => {
    for (const pop of [population(200_000, 5e9), population(5_000, 1e12, 2), population(100, 50)]) {
      const { distributionTiers, balanceRanges, retailThreshold, megaHolderThreshold, concentrationBuckets } = deriveHolderTiers(pop, {
        supplyTarget: 1e12,
      });
      expect(retailThreshold).toBe(distributionTiers.at(-2)?.min ?? 1);
      expect(retailThreshold).toBeGreaterThanOrEqual(1);
      expect(() => normalizeHolderTiers({ retailThreshold, megaHolderThreshold, concentrationBuckets, distributionTiers, balanceRanges })).not.toThrow();
    }
  });

  it("keeps concentration buckets smaller than the holder count, but never empty", () => {
    const all = loadDefaultHolderTiersRaw().concentrationBuckets;
    expect(deriveHolderTiers(population(200_000, 5e9)).concentrationBuckets).toEqual(all);
    const few = deriveHolderTiers(population(60, 1e3)).concentrationBuckets;
    expect(few).toEqual(all.filter((n) => n < 60));
    expect(deriveHolderTiers([3, 3, 3]).concentrationBuckets).toEqual([Math.min(...all)]);
  });

  it("handles a project with only a few holders", () => {
    const { distributionTiers } = deriveHolderTiers([3, 3, 3]);
    expect(distributionTiers.at(-1)).toMatchObject({ min: 1 });
    expect(distributionTiers[0].max).toBeNull();
    expect(() => deriveHolderTiers([0.2])).toThrow(/no holder/);
  });
});
