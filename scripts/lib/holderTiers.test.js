import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeHolderTiers,
  projectHolderTiers,
  defaultHolderTiers,
  rangeLabelOf,
  bucketFloor,
} from "./holderTiers.js";
import {
  BALANCE_RANGES,
  DISTRIBUTION_RANGES,
  CONCENTRATION_BUCKETS,
  TEL_BALANCE_RANGES,
  TEL_DISTRIBUTION_RANGES,
  TEL_CONCENTRATION_BUCKETS,
  setHolderTiers,
  buildBalanceStats,
  buildConcentration,
} from "./holdersView.js";
import { RETAIL_THRESHOLD, MEGA_HOLDER_THRESHOLD } from "./holderMetrics.js";
import { resolveProject } from "./projects.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const tel = resolveProject("tel", ROOT);

// Verbatim copies of the constants the pipelines hard-coded before tiers
// became project config (holderMetrics.js, holdersView.js,
// generate-holder-transitions.js RANGES, generate-tier-outflows.js TIERS).
const OLD_RETAIL_THRESHOLD = 1_000;
const OLD_MEGA_HOLDER_THRESHOLD = 20_000_000_000;
const OLD_CONCENTRATION_BUCKETS = [10, 25, 50, 100, 250, 500, 1000];
const OLD_BALANCE_RANGES = [
  { label: "1–100", min: 1, max: 100 },
  { label: "100–1K", min: 100, max: 1_000 },
  { label: "1K–10K", min: 1_000, max: 10_000 },
  { label: "10K–100K", min: 10_000, max: 100_000 },
  { label: "100K–1M", min: 100_000, max: 1_000_000 },
  { label: "1M–10M", min: 1_000_000, max: 10_000_000 },
  { label: "10M+", min: 10_000_000, max: Number.POSITIVE_INFINITY },
];
const OLD_TIER_TUPLES = [
  ["500M+", 500e6, Infinity], ["250M-500M", 250e6, 500e6], ["100M-250M", 100e6, 250e6],
  ["50M-100M", 50e6, 100e6], ["25M-50M", 25e6, 50e6], ["10M-25M", 10e6, 25e6],
  ["5M-10M", 5e6, 10e6], ["1M-5M", 1e6, 5e6], ["250K-1M", 250e3, 1e6], ["1-250K", 1, 250e3],
];
const OLD_DISTRIBUTION_RANGES = OLD_TIER_TUPLES.map(([label, min, max]) => ({ label, min, max }));
const oldTierOf = (v) => {
  for (const [label, lo, hi] of OLD_TIER_TUPLES) if (v >= lo && v < hi) return label;
  return null;
};

afterEach(() => setHolderTiers(null));

describe("TEL holder tiers are byte-identical to the old constants", () => {
  it("tel.json `holders` and config/holder-tiers.default.json both resolve to the old values", () => {
    for (const tiers of [projectHolderTiers(tel), defaultHolderTiers()]) {
      expect(tiers.retailThreshold).toBe(OLD_RETAIL_THRESHOLD);
      expect(tiers.megaHolderThreshold).toBe(OLD_MEGA_HOLDER_THRESHOLD);
      expect(tiers.concentrationBuckets).toEqual(OLD_CONCENTRATION_BUCKETS);
      expect(tiers.balanceRanges).toEqual(OLD_BALANCE_RANGES);
      expect(tiers.distributionTiers).toEqual(OLD_DISTRIBUTION_RANGES);
    }
  });

  it("tel.json carries an explicit block equal to the shared defaults file", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "config/holder-tiers.default.json"), "utf8"));
    const { $comment: _a, ...telBlock } = tel.config.holders;
    const { $comment: _b, ...defaults } = raw;
    expect(telBlock).toEqual(defaults);
  });

  it("the module-level TEL constants match the old values too", () => {
    expect(RETAIL_THRESHOLD).toBe(OLD_RETAIL_THRESHOLD);
    expect(MEGA_HOLDER_THRESHOLD).toBe(OLD_MEGA_HOLDER_THRESHOLD);
    expect(TEL_BALANCE_RANGES).toEqual(OLD_BALANCE_RANGES);
    expect(TEL_DISTRIBUTION_RANGES).toEqual(OLD_DISTRIBUTION_RANGES);
    expect(TEL_CONCENTRATION_BUCKETS).toEqual(OLD_CONCENTRATION_BUCKETS);
    // Applying TEL's project tiers leaves the live bindings at the same values.
    setHolderTiers(projectHolderTiers(tel));
    expect(BALANCE_RANGES).toEqual(OLD_BALANCE_RANGES);
    expect(DISTRIBUTION_RANGES).toEqual(OLD_DISTRIBUTION_RANGES);
    expect(CONCENTRATION_BUCKETS).toEqual(OLD_CONCENTRATION_BUCKETS);
  });

  it("rangeLabelOf(TEL tiers) buckets every value exactly like the old tierOf/bucketOf", () => {
    const tiers = projectHolderTiers(tel).distributionTiers;
    const edges = OLD_TIER_TUPLES.flatMap(([, lo, hi]) => [lo, hi]).filter(Number.isFinite);
    const probes = [0, 0.5, 0.999, ...edges.flatMap((e) => [e - 0.01, e, e + 0.01]), 7.5e8, 1e12];
    for (const v of probes) expect(rangeLabelOf(tiers, v)).toBe(oldTierOf(v));
  });

  it("the ported generators no longer carry their own tier tables", () => {
    for (const f of ["scripts/generate-holder-transitions.js", "scripts/generate-tier-outflows.js"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src).toContain("projectHolderTiers(project).distributionTiers");
      expect(src).not.toMatch(/\["500M\+", 500e6/);
    }
  });
});

describe("a project can set its own tiers", () => {
  const demo = {
    slug: "demo",
    holders: {
      retailThreshold: 10,
      megaHolderThreshold: 50_000_000,
      concentrationBuckets: [5, 20],
      balanceRanges: [
        { label: "0.01–1", min: 0.01, max: 1 },
        { label: "1–1K", min: 1, max: 1000 },
        { label: "1K+", min: 1000, max: null },
      ],
      distributionTiers: [
        { label: "1M+", min: 1_000_000, max: null },
        { label: "10K-1M", min: 10_000, max: 1_000_000 },
        { label: "0.01-10K", min: 0.01, max: 10_000 },
      ],
    },
  };

  it("normalizes a full block (null max = open top)", () => {
    const t = projectHolderTiers({ config: demo });
    expect(t.retailThreshold).toBe(10);
    expect(t.megaHolderThreshold).toBe(50_000_000);
    expect(t.concentrationBuckets).toEqual([5, 20]);
    expect(t.balanceRanges.at(-1)).toEqual({ label: "1K+", min: 1000, max: Infinity });
    expect(t.distributionTiers.map((r) => r.label)).toEqual(["1M+", "10K-1M", "0.01-10K"]);
    expect(bucketFloor(t)).toBe(0.01);
    expect(rangeLabelOf(t.distributionTiers, 5)).toBe("0.01-10K");
    expect(rangeLabelOf(t.distributionTiers, 2e6)).toBe("1M+");
  });

  it("falls back to the defaults field by field", () => {
    const t = projectHolderTiers({ config: { slug: "partial", holders: { retailThreshold: 5 } } });
    expect(t.retailThreshold).toBe(5);
    expect(t.megaHolderThreshold).toBe(OLD_MEGA_HOLDER_THRESHOLD);
    expect(t.distributionTiers).toEqual(OLD_DISTRIBUTION_RANGES);
    expect(projectHolderTiers({ config: { slug: "none" } })).toEqual(defaultHolderTiers());
  });

  it("drives holdersView's builders once applied", () => {
    setHolderTiers(projectHolderTiers({ config: demo }));
    const holders = [{ balance: 0.5 }, { balance: 20 }, { balance: 5000 }, { balance: 7 }];
    const stats = buildBalanceStats(holders);
    expect(stats.distributionBuckets.map((b) => [b.rangeLabel, b.count])).toEqual([
      ["0.01–1", 1], ["1–1K", 2], ["1K+", 1],
    ]);
    expect(Object.keys(buildConcentration(holders).top)).toEqual(["5", "20"]);
    setHolderTiers(null);
    expect(buildBalanceStats(holders).distributionBuckets.map((b) => b.rangeLabel)).toEqual(OLD_BALANCE_RANGES.map((r) => r.label));
  });

  it("rejects overlapping, unordered or inconsistent blocks", () => {
    const bad = (holders) => () => normalizeHolderTiers(holders);
    expect(bad({ megaHolderThreshold: 500 })).toThrow(/megaHolderThreshold/);
    expect(bad({ distributionTiers: [{ label: "a", min: 0, max: 10 }, { label: "b", min: 5, max: null }] })).toThrow(/largest -> smallest/);
    expect(bad({ balanceRanges: [{ label: "a", min: 10, max: null }, { label: "b", min: 1, max: 10 }] })).toThrow(/smallest -> largest/);
    expect(bad({ balanceRanges: [{ label: "a", min: 1, max: 10 }, { label: "a", min: 10, max: null }] })).toThrow(/duplicate/);
    expect(bad({ concentrationBuckets: [0] })).toThrow(/concentrationBuckets/);
  });
});
