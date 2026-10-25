/**
 * Per-project holder-tier settings for the pipelines.
 *
 * Every TEL-sized number the holder pipelines used to hard-code — the retail
 * threshold, the mega-holder cutoff, the Wallet Holdings balance ranges, the
 * Distribution tiers (the tier-flow join keys) and the top-N concentration
 * sizes — now comes from the project's `holders` block in
 * config/projects/<slug>.json. Any field a project omits falls back to
 * config/holder-tiers.default.json, which holds TEL's historical values, so
 * a run for TEL is byte-identical to the old constants (holderTiers.test.js).
 *
 * The UI reads the same block through src/lib/holderTiers.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULTS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config/holder-tiers.default.json");

const finite = (v) => typeof v === "number" && Number.isFinite(v);

const normalizeRanges = (list, field, owner) => {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${owner}: holders.${field} must be a non-empty array`);
  const seen = new Set();
  return list.map((r, i) => {
    const label = typeof r?.label === "string" ? r.label.trim() : "";
    if (!label) throw new Error(`${owner}: holders.${field}[${i}] needs a label`);
    if (seen.has(label)) throw new Error(`${owner}: holders.${field} has duplicate label "${label}"`);
    seen.add(label);
    const min = Number(r.min);
    const max = r.max === null || r.max === undefined ? Number.POSITIVE_INFINITY : Number(r.max);
    if (!Number.isFinite(min) || min < 0) throw new Error(`${owner}: holders.${field}[${i}] min must be a number >= 0`);
    if (!(max > min)) throw new Error(`${owner}: holders.${field}[${i}] max must be > min (or null for no upper bound)`);
    return { label, min, max };
  });
};

const assertOrdered = (ranges, dir, field, owner) => {
  for (let i = 1; i < ranges.length; i += 1) {
    const ok = dir === "asc" ? ranges[i].min >= ranges[i - 1].max : ranges[i].max <= ranges[i - 1].min;
    if (!ok) throw new Error(`${owner}: holders.${field} must be ${dir === "asc" ? "smallest -> largest" : "largest -> smallest"} and non-overlapping`);
  }
};

/**
 * Validate and fill a raw `holders` block (fields missing -> defaults).
 * @returns {{ retailThreshold: number, megaHolderThreshold: number, concentrationBuckets: number[],
 *   balanceRanges: Array<{label:string,min:number,max:number}>, distributionTiers: Array<{label:string,min:number,max:number}> }}
 */
export function normalizeHolderTiers(raw = {}, defaults = loadDefaultHolderTiersRaw(), owner = "holders") {
  const pick = (k) => (raw?.[k] !== undefined ? raw[k] : defaults[k]);
  const retailThreshold = pick("retailThreshold");
  const megaHolderThreshold = pick("megaHolderThreshold");
  if (!finite(retailThreshold) || retailThreshold < 0) throw new Error(`${owner}: holders.retailThreshold must be a number >= 0`);
  if (!finite(megaHolderThreshold) || megaHolderThreshold <= retailThreshold) {
    throw new Error(`${owner}: holders.megaHolderThreshold must be a number > retailThreshold`);
  }
  const concentrationBuckets = pick("concentrationBuckets");
  if (!Array.isArray(concentrationBuckets) || concentrationBuckets.length === 0 || !concentrationBuckets.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error(`${owner}: holders.concentrationBuckets must be positive integers`);
  }
  const balanceRanges = normalizeRanges(pick("balanceRanges"), "balanceRanges", owner);
  const distributionTiers = normalizeRanges(pick("distributionTiers"), "distributionTiers", owner);
  assertOrdered(balanceRanges, "asc", "balanceRanges", owner);
  assertOrdered(distributionTiers, "desc", "distributionTiers", owner);
  return { retailThreshold, megaHolderThreshold, concentrationBuckets: [...concentrationBuckets], balanceRanges, distributionTiers };
}

let defaultsRaw = null;
export function loadDefaultHolderTiersRaw() {
  if (!defaultsRaw) defaultsRaw = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));
  return defaultsRaw;
}

/** Defaults (TEL's historical values), normalized. */
export const defaultHolderTiers = () => normalizeHolderTiers({}, loadDefaultHolderTiersRaw(), "config/holder-tiers.default.json");

/** Holder tiers for a resolved project (`{ slug, config }`) or a raw project config. */
export function projectHolderTiers(project) {
  const config = project?.config ?? project;
  return normalizeHolderTiers(config?.holders ?? {}, loadDefaultHolderTiersRaw(), `project ${config?.slug ?? "?"}`);
}

/** Label of the range containing `v` (min inclusive, max exclusive), or null. */
export const rangeLabelOf = (ranges, v) => {
  for (const r of ranges) if (v >= r.min && v < r.max) return r.label;
  return null;
};

/** Smallest balance any bucket counts (TEL: 1 — sub-1 dust is excluded from buckets). */
export const bucketFloor = (tiers) => Math.min(...tiers.balanceRanges.map((r) => r.min), ...tiers.distributionTiers.map((r) => r.min));
