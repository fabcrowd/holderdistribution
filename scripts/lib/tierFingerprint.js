/**
 * Detects when a project's distribution tiers changed under a persisted
 * per-day tier store (day buckets are keyed by tier label, so a label change
 * would otherwise leave old and new labels mixed forever).
 */
import { createHash } from "node:crypto";

/** Stable hash of the ordered tier labels + bounds (an open max hashes as null). */
export function tierFingerprint(tiers) {
  const canon = tiers.map((t) => [t.label, t.min, Number.isFinite(t.max) ? t.max : null]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

/** Distinct tier labels used by the day buckets of a store. */
export function storedTierLabels(days) {
  const labels = new Set();
  for (const d of days ?? []) for (const label of Object.keys(d?.tiers ?? {})) labels.add(label);
  return labels;
}

/**
 * @param {{ tierFingerprint?: string, days?: Array<{tiers?: object}> }} store
 * @param {Array<{label:string,min:number,max:number}>} tiers current tiers
 * @returns {{ reset: boolean, reason: string | null }}
 */
export function shouldResetForTiers(store, tiers) {
  const current = tierFingerprint(tiers);
  const labels = storedTierLabels(store?.days);
  if (store?.tierFingerprint) {
    return store.tierFingerprint === current
      ? { reset: false, reason: null }
      : { reset: true, reason: `tier fingerprint ${store.tierFingerprint} != ${current}` };
  }
  if (labels.size === 0) return { reset: false, reason: null };
  const currentLabels = new Set(tiers.map((t) => t.label));
  const foreign = [...labels].filter((l) => !currentLabels.has(l));
  return foreign.length === 0
    ? { reset: false, reason: null }
    : { reset: true, reason: `legacy store has labels not in current tiers (${foreign.slice(0, 3).join(", ")})` };
}
