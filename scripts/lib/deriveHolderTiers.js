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
 * @param {number[]} balances human-unit balances of every holder (any order; entries below 1 are ignored)
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
  return {
    distributionTiers,
    balanceRanges,
    megaHolderThreshold: supplyTarget === undefined ? null : supplyTarget / MEGA_SUPPLY_DIVISOR,
    retailThreshold,
    concentrationBuckets: concentrationBucketsFor(sorted.length),
    holders: sorted.length,
    tierShares,
    largestTierShare: Math.max(...Object.values(tierShares)),
  };
}
