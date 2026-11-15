/**
 * Holder tiers derived from one project's own holder balances.
 *
 * Tiers are never copied or scaled from another project (TEL, ONDO): each
 * project's edges come from where its own wallets sit. Distribution tier edges
 * are the balances at fixed holder ranks from the top (the top 0.01% of
 * wallets, 0.03%, ... 60%), rounded down to 1 / 2.5 / 5 x 10^k so labels stay
 * readable. Wallet Holdings ranges are evenly spaced powers of ten from 1 up to
 * the balance of the top 0.1% of wallets, at most eight ranges.
 *
 * Balances below 1 are ignored, unless folding them into the bottom tier would
 * put more than MAX_TIER_SHARE of all positive-balance wallets in it; then tiers
 * below 1 are added (owner rule 2026-11-14: every positive balance is listed).
 *
 * Tier labels are join keys into holders-history, holder-transitions and
 * tier-outflows, so a live project keeps its tiers once data exists; changing
 * them needs a regeneration (README, "ONDO gets its own holder tiers").
 */
import { loadDefaultHolderTiersRaw } from "./holderTiers.js";

const RANK_FRACTIONS = [0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 0.6];
const RANGES_TOP_FRACTION = 0.001;
const MAX_BALANCE_RANGES = 8;
/** A tier holding more than this share of wallets hides the distribution (ONDO had 99.8% in one tier). */
export const MAX_TIER_SHARE = 0.9;
/** Largest wallet share a tier below 1 may take, unless one repeated balance value makes that impossible. */
export const MAX_DUST_TIER_SHARE = 0.35;
const MAX_DUST_DECADE = 18;

const MANTISSAS = [1, 2.5, 5];

/** Largest 1 / 2.5 / 5 x 10^k at or below `x` (x >= 1). */
export function floorToLadder(x) {
  let best = 1;
  for (let k = 0; k <= 18; k += 1) {
    for (const m of MANTISSAS) {
      const v = m * 10 ** k;
      if (v > x) return best;
      best = v;
    }
  }
  return best;
}

const floorPow10 = (x) => 10 ** Math.floor(Math.log10(x));

/** 2500 -> "2.5K", 125000000 -> "125M", 7 -> "7". */
export function compact(v) {
  for (const [div, unit] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (v >= div) return `${+(v / div).toFixed(3)}${unit}`;
  }
  return String(v);
}

/** Balance of the wallet at `fraction` of the way down the list (sorted largest first). */
const atRank = (sorted, fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];

/** Wallets above 1/5 of supply are held out of retail as "mega" (TEL 100B -> 20B, ONDO 10B -> 2B). A divisor, so the result is exact. */
export const MEGA_SUPPLY_DIVISOR = 5;

/** Top-N sizes only make sense below the holder count; the smallest is always kept so the list is never empty. */
const concentrationBucketsFor = (holders) => {
  const all = loadDefaultHolderTiersRaw().concentrationBuckets;
  const fitting = all.filter((n) => n < holders);
  return fitting.length > 0 ? fitting : [Math.min(...all)];
};

/**
 * @param {number[]} balances human-unit balances of every holder (any order; zero, negative and non-finite entries are
 *   ignored; entries below 1 are ignored unless folding them into the bottom tier would exceed MAX_TIER_SHARE of all
 *   positive-balance wallets, then tiers below 1 are added)
 * @param {{ supplyTarget?: number }} [opts] supplyTarget (tokens) sizes megaHolderThreshold; null when omitted
 * @returns {{ distributionTiers: Array<{label:string,min:number,max:number|null}>,
 *   balanceRanges: Array<{label:string,min:number,max:number|null}>,
 *   megaHolderThreshold: number|null, retailThreshold: number, concentrationBuckets: number[],
 *   holders: number, tierShares: Record<string, number>, largestTierShare: number }}
 */
export function deriveHolderTiers(balances, { supplyTarget } = {}) {
  if (supplyTarget !== undefined && !(Number.isFinite(supplyTarget) && supplyTarget > 0)) {
    throw new Error(`deriveHolderTiers: supplyTarget must be a finite number > 0, got ${supplyTarget}`);
  }
  const { result, counts } = deriveAtOrAboveOne(balances, supplyTarget);
  const dust = balances.filter((b) => Number.isFinite(b) && b > 0 && b < 1).sort((a, b) => a - b);
  if (dust.length === 0) return result;
  const total = result.holders + dust.length;
  const bottomLabel = result.distributionTiers.at(-1).label;
  if ((counts[bottomLabel] + dust.length) / total <= MAX_TIER_SHARE) return result;
  return withDustTiers(result, counts, dust, total);
}

/** Plain decimal text for values >= 1e-8 (no exponent, no float noise), JS exponent form below. */
function fmt(v) {
  if (v >= 1) return String(v);
  if (v < 1e-8) return String(v);
  return v.toFixed(8).replace(/0+$/, "");
}

const decade = (k) => Number(`1e-${k}`);

/** Count of entries in ascending `dust` strictly below `x`. */
function countBelow(dust, x) {
  let lo = 0;
  let hi = dust.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dust[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Tiers below 1 for ascending `dust` (all in (0, 1)), descending and contiguous from 1, ending open at 0. */
function dustTiersFor(dust, total) {
  const cap = MAX_DUST_TIER_SHARE * total;
  let maxK = 1;
  while (maxK < MAX_DUST_DECADE && decade(maxK) > dust[0]) maxK += 1;
  const tiers = [];
  let upper = 1;
  let kUpper = 0;
  const closeBottom = () => tiers.push({ label: `<${fmt(upper)}`, min: 0, max: upper });
  for (;;) {
    if (countBelow(dust, upper) <= cap || kUpper >= maxK) break;
    let k = kUpper + 1;
    const inTier = (kk) => countBelow(dust, upper) - countBelow(dust, decade(kk));
    while (k < maxK && (inTier(k) === 0 || inTier(k + 1) <= cap)) k += 1;
    if (countBelow(dust, decade(k)) === 0 || inTier(k) === 0) break;
    tiers.push({ label: `${fmt(decade(k))}-${fmt(upper)}`, min: decade(k), max: upper });
    upper = decade(k);
    kUpper = k;
  }
  closeBottom();
  return tiers;
}

function withDustTiers(legacy, legacyCounts, dust, total) {
  const dustTiers = dustTiersFor(dust, total);
  const counts = { ...legacyCounts };
  for (const t of dustTiers) counts[t.label] = countBelow(dust, t.max) - countBelow(dust, t.min);
  const distributionTiers = [...legacy.distributionTiers, ...dustTiers];
  const tierShares = Object.fromEntries(distributionTiers.map((t) => [t.label, counts[t.label] / total]));
  return {
    ...legacy,
    distributionTiers,
    balanceRanges: [{ label: "<1", min: 0, max: 1 }, ...legacy.balanceRanges],
    holders: total,
    tierShares,
    largestTierShare: Math.max(...Object.values(tierShares)),
  };
}

/** The ladder from wallets at or above 1: today's derivation, unchanged. Also returns the per-tier counts. */
function deriveAtOrAboveOne(balances, supplyTarget) {
  const sorted = balances.filter((b) => Number.isFinite(b) && b >= 1).sort((a, b) => b - a);
  if (sorted.length === 0) throw new Error("deriveHolderTiers: no holder with a balance of at least 1");

  const edges = [...new Set(RANK_FRACTIONS.map((f) => floorToLadder(atRank(sorted, f))))].filter((e) => e > 1).sort((a, b) => b - a);
  const distributionTiers = [];
  edges.forEach((min, i) => {
    const max = i === 0 ? null : edges[i - 1];
    distributionTiers.push({ label: max === null ? `${compact(min)}+` : `${compact(min)}-${compact(max)}`, min, max });
  });
  const bottomMax = edges.at(-1) ?? null;
  distributionTiers.push({ label: bottomMax === null ? "1+" : `1-${compact(bottomMax)}`, min: 1, max: bottomMax });

  const decades = Math.max(1, Math.round(Math.log10(floorPow10(atRank(sorted, RANGES_TOP_FRACTION)))));
  const step = Math.ceil(decades / (MAX_BALANCE_RANGES - 1));
  const rangeEdges = [];
  for (let k = 0; k <= decades; k += step) rangeEdges.push(10 ** k);
  const balanceRanges = rangeEdges.map((min, i) => {
    const max = rangeEdges[i + 1] ?? null;
    return { label: max === null ? `${compact(min)}+` : `${compact(min)}–${compact(max)}`, min, max };
  });

  const counts = Object.fromEntries(distributionTiers.map((t) => [t.label, 0]));
  for (const b of sorted) {
    const tier = distributionTiers.find((t) => b >= t.min && (t.max === null || b < t.max));
    counts[tier.label] += 1;
  }
  const tierShares = Object.fromEntries(Object.entries(counts).map(([label, n]) => [label, n / sorted.length]));
  // Retail = every wallet above the bottom dust tier; with a single tier there is no dust tier to skip.
  const retailThreshold = distributionTiers.at(-2)?.min ?? 1;
  const result = {
    distributionTiers,
    balanceRanges,
    megaHolderThreshold: supplyTarget === undefined ? null : supplyTarget / MEGA_SUPPLY_DIVISOR,
    retailThreshold,
    concentrationBuckets: concentrationBucketsFor(sorted.length),
    holders: sorted.length,
    tierShares,
    largestTierShare: Math.max(...Object.values(tierShares)),
  };
  return { result, counts };
}
