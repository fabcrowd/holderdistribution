/**
 * Holder-tier settings for the UI — the browser twin of
 * scripts/lib/holderTiers.js. A project's `holders` block in
 * config/projects/<slug>.json wins field by field; anything it omits comes
 * from config/holder-tiers.default.json (TEL's historical values, so TEL
 * renders exactly as before). Distribution tier labels are the join keys into
 * holder-transitions.json / tier-outflows.json.
 */
import defaults from "../../config/holder-tiers.default.json";
import type { ProjectConfig } from "@/lib/projects";

export type TierRange = { label: string; min: number; max: number };
export type RawTierRange = { label: string; min: number; max: number | null };

export type HolderTiersRaw = {
  retailThreshold?: number;
  megaHolderThreshold?: number;
  concentrationBuckets?: number[];
  balanceRanges?: RawTierRange[];
  distributionTiers?: RawTierRange[];
};

export type HolderTiers = {
  retailThreshold: number;
  megaHolderThreshold: number;
  concentrationBuckets: number[];
  /** Wallet Holdings balance ranges, smallest -> largest. */
  balanceRanges: TierRange[];
  /** Distribution / tier-flow tiers, largest -> smallest. */
  distributionTiers: TierRange[];
};

const toRanges = (list: RawTierRange[]): TierRange[] =>
  list.map((r) => ({ label: r.label, min: r.min, max: r.max === null || r.max === undefined ? Number.POSITIVE_INFINITY : r.max }));

const DEFAULTS = defaults as unknown as Required<HolderTiersRaw>;

export const normalizeHolderTiers = (raw: HolderTiersRaw | undefined): HolderTiers => ({
  retailThreshold: raw?.retailThreshold ?? DEFAULTS.retailThreshold,
  megaHolderThreshold: raw?.megaHolderThreshold ?? DEFAULTS.megaHolderThreshold,
  concentrationBuckets: [...(raw?.concentrationBuckets ?? DEFAULTS.concentrationBuckets)],
  balanceRanges: toRanges(raw?.balanceRanges ?? DEFAULTS.balanceRanges),
  distributionTiers: toRanges(raw?.distributionTiers ?? DEFAULTS.distributionTiers),
});

const cache = new WeakMap<object, HolderTiers>();
const DEFAULT_TIERS = normalizeHolderTiers(undefined);

/** Holder tiers for a project config (memoized per config object). */
export const holderTiersFor = (project: Pick<ProjectConfig, "holders"> | null | undefined): HolderTiers => {
  if (!project?.holders) return DEFAULT_TIERS;
  let t = cache.get(project);
  if (!t) {
    t = normalizeHolderTiers(project.holders);
    cache.set(project, t);
  }
  return t;
};

/** TEL's historical tiers (config/holder-tiers.default.json). */
export const defaultHolderTiers = (): HolderTiers => DEFAULT_TIERS;

/** Smallest balance any bucket counts (TEL: 1 — sub-1 dust is left out of buckets). */
export const bucketFloor = (t: HolderTiers): number => Math.min(...t.balanceRanges.map((r) => r.min));
