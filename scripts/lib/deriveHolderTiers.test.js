import { describe, expect, it } from "vitest";
import { compact, deriveHolderTiers, floorToLadder, MAX_DUST_TIER_SHARE, MAX_TIER_SHARE } from "./deriveHolderTiers.js";
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

/** Output of the pre-dust code for population(2000, 1e7) plus 160 dust wallets (7.4%), supplyTarget 1e9. Captured by running the old function before the dust change. */
const OLD_BEHAVIOUR = {
  distributionTiers: [
    { label: "10M+", min: 10000000, max: null },
    { label: "2.5M-10M", min: 2500000, max: 10000000 },
    { label: "500K-2.5M", min: 500000, max: 2500000 },
    { label: "50K-500K", min: 50000, max: 500000 },
    { label: "10K-50K", min: 10000, max: 50000 },
    { label: "1K-10K", min: 1000, max: 10000 },
    { label: "250-1K", min: 250, max: 1000 },
    { label: "100-250", min: 100, max: 250 },
    { label: "1-100", min: 1, max: 100 },
  ],
  balanceRanges: [
    { label: "1–10", min: 1, max: 10 },
    { label: "10–100", min: 10, max: 100 },
    { label: "100–1K", min: 100, max: 1000 },
    { label: "1K–10K", min: 1000, max: 10000 },
    { label: "10K–100K", min: 10000, max: 100000 },
    { label: "100K–1M", min: 100000, max: 1000000 },
    { label: "1M+", min: 1000000, max: null },
  ],
  megaHolderThreshold: 200000000,
  retailThreshold: 100,
  concentrationBuckets: [10, 25, 50, 100, 250, 500, 1000],
  holders: 2000,
  tierShares: { "10M+": 0.0005, "2.5M-10M": 0.0005, "500K-2.5M": 0.002, "50K-500K": 0.0105, "10K-50K": 0.0235, "1K-10K": 0.121, "250-1K": 0.218, "100-250": 0.2905, "1-100": 0.3335 },
  largestTierShare: 0.3335,
};

const upperPop = () => population(14_000, 1e7);
const spread = (n, lo, hi) => Array.from({ length: n }, (_, i) => 10 ** (Math.log10(lo) + ((i + 0.5) / n) * (Math.log10(hi) - Math.log10(lo))));
const plain = /^(<?\d+(\.\d+)?|\d+(\.\d+)?-\d+(\.\d+)?)$/;

describe("balances below 1 (dust)", () => {
  it("leaves the derivation byte-identical when folding dust into the bottom tier stays under the limit", () => {
    const pop = population(2000, 1e7);
    const dust = Array.from({ length: 160 }, (_, i) => 0.001 + i * 0.005);
    expect(deriveHolderTiers([...pop, ...dust], { supplyTarget: 1e9 })).toEqual(OLD_BEHAVIOUR);
    expect(deriveHolderTiers(pop, { supplyTarget: 1e9 })).toEqual(OLD_BEHAVIOUR);
    const base = deriveHolderTiers(upperPop());
    for (const share of [0, 0.08, 0.45]) {
      const withDust = deriveHolderTiers([...upperPop(), ...spread(Math.round((14_000 * share) / (1 - share)), 1e-8, 1)]);
      expect(withDust).toEqual(base);
      expect(Object.keys(withDust)).toEqual(Object.keys(base));
    }
  });

  it("adds dust tiers only once the folded bottom tier would exceed the share limit", () => {
    const pop = upperPop();
    const base = deriveHolderTiers(pop);
    const bottom = Math.round(base.tierShares[base.distributionTiers.at(-1).label] * pop.length);
    // folded share (bottom + d) / (14000 + d) <= 0.9  <=>  d <= (0.9 * 14000 - bottom) / 0.1
    const limit = Math.floor((MAX_TIER_SHARE * pop.length - bottom) / (1 - MAX_TIER_SHARE));
    expect(deriveHolderTiers([...pop, ...spread(limit, 1e-8, 1)])).toEqual(base);
    const over = deriveHolderTiers([...pop, ...spread(limit + 2, 1e-8, 1)]);
    expect(over.distributionTiers.length).toBeGreaterThan(base.distributionTiers.length);
    expect(over.distributionTiers.at(-1).min).toBe(0);
  });

  const shapes = {
    "log-uniform between 1e-8 and 1": () => spread(86_000, 1e-8, 1),
    "60% at exactly 1e-8": () => [...Array(51_600).fill(1e-8), ...spread(34_400, 1e-8, 1)],
    "60% at 0.001": () => [...Array(51_600).fill(0.001), ...spread(34_400, 1e-8, 1)],
    "all at 1e-8": () => Array(86_000).fill(1e-8),
  };
  for (const [name, makeDust] of Object.entries(shapes)) {
    it(`HBAR-like shape, ${name}: tiers below 1, ladder and retail unchanged`, () => {
      const upper = upperPop();
      const dust = makeDust();
      const base = deriveHolderTiers(upper, { supplyTarget: 1e12 });
      const r = deriveHolderTiers([...upper, ...dust], { supplyTarget: 1e12 });
      const dustTiers = r.distributionTiers.slice(base.distributionTiers.length);
      expect(dustTiers.length).toBeGreaterThan(0);
      expect(r.distributionTiers.slice(0, base.distributionTiers.length)).toEqual(base.distributionTiers);
      expect(r.balanceRanges).toEqual([{ label: "<1", min: 0, max: 1 }, ...base.balanceRanges]);
      expect(r.retailThreshold).toBe(base.retailThreshold);
      expect(r.concentrationBuckets).toEqual(base.concentrationBuckets);
      expect(r.megaHolderThreshold).toBe(base.megaHolderThreshold);
      expect(r.holders).toBe(upper.length + dust.length);
      // one repeated balance value can make a single decade exceed the cap; "all at 1e-8" is the unsplittable case
      if (name !== "all at 1e-8") expect(r.largestTierShare).toBeLessThanOrEqual(MAX_TIER_SHARE);
      expect(r.largestTierShare).toBe(Math.max(...Object.values(r.tierShares)));
      expect(Object.values(r.tierShares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(dustTiers[0].max).toBe(base.distributionTiers.at(-1).min);
      for (let i = 1; i < dustTiers.length; i += 1) {
        expect(dustTiers[i].max).toBe(dustTiers[i - 1].min);
        expect(dustTiers[i].min).toBeLessThan(dustTiers[i].max);
      }
      expect(dustTiers.at(-1).min).toBe(0);
      const labels = r.distributionTiers.map((t) => t.label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const l of dustTiers.map((t) => t.label)) expect(l).toMatch(plain);
      expect(Object.values(r.tierShares).every((s) => s > 0)).toBe(true);
      const normalized = normalizeHolderTiers({
        retailThreshold: r.retailThreshold,
        megaHolderThreshold: 1e12 / 5,
        concentrationBuckets: r.concentrationBuckets,
        distributionTiers: r.distributionTiers,
        balanceRanges: r.balanceRanges,
      });
      expect(normalized.distributionTiers.at(-1).min).toBe(0);
    });
  }

  it("keeps splittable dust tiers at or under the dust share cap", () => {
    const r = deriveHolderTiers([...upperPop(), ...spread(86_000, 1e-8, 1)]);
    for (const t of r.distributionTiers.filter((x) => x.max <= 1)) expect(r.tierShares[t.label]).toBeLessThanOrEqual(MAX_DUST_TIER_SHARE + 1e-12);
    expect(r.distributionTiers.at(-1).label).toMatch(/^</);
  });

  it("labels use plain decimals down to 1e-8 and JS exponent form below", () => {
    const r = deriveHolderTiers([...upperPop(), ...spread(86_000, 1e-12, 1)]);
    const labels = r.distributionTiers.filter((t) => t.max !== null && t.max <= 1).map((t) => t.label);
    expect(labels).toEqual(["0.0001-1", "0.00000001-0.0001", "<0.00000001"]);
    const deeper = deriveHolderTiers([...upperPop(), ...Array(86_000).fill(1e-12), ...spread(40_000, 1e-9, 1e-8)]);
    const deepLabels = deeper.distributionTiers.filter((t) => t.max !== null && t.max <= 1).map((t) => t.label);
    expect(deepLabels.some((l) => l.includes("e-"))).toBe(true);
    expect(deepLabels.some((l) => /(^|-|<)1e-[1-7]($|-)/.test(l))).toBe(false);
  });

  it("returns normally with a dust tier above the limit when one balance value cannot be split", () => {
    const r = deriveHolderTiers([...population(50, 1e6), ...Array(2000).fill(1e-8)]);
    expect(r.distributionTiers.at(-1)).toEqual({ label: "<1", min: 0, max: 1 });
    expect(r.largestTierShare).toBeGreaterThan(MAX_TIER_SHARE);
    expect(r.holders).toBe(2050);
  });

  it("ignores zero, negative, NaN and Infinity entries", () => {
    const pop = [...upperPop(), ...spread(86_000, 1e-8, 1)];
    const noise = [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    expect(deriveHolderTiers([...pop, ...noise])).toEqual(deriveHolderTiers(pop));
    const small = [...upperPop(), ...spread(100, 1e-8, 1)];
    expect(deriveHolderTiers([...small, ...noise])).toEqual(deriveHolderTiers(small));
  });
});
