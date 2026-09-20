/**
 * Coverage detection for per-counterparty-tier attribution.
 *
 * These predicates decide what `sourceTierSince` and per-range
 * `attributedDays`/`totalDays` report, which is what the UI uses to caveat a
 * window whose history predates attribution. Getting them wrong doesn't break
 * the build — it makes the product make a confident, false claim — so they
 * live here as pure functions with tests rather than inline in the generator.
 *
 * The subtlety: `reconcileParts` gives EVERY day that had wallet flow at least
 * an `untracked` entry, so "the breakdown map is non-empty" is true for all of
 * pre-attribution history. Testing that would report a fully-untracked year as
 * "365 of 365 days attributed". Real attribution means at least one key that
 * names an actual counterparty tier.
 */

/** True if a tier cell resolved any flow to a real counterparty tier. */
export const cellHasAttribution = (t) =>
  Object.keys(t?.inflowsBySourceTier ?? {}).some((k) => k !== "untracked")
  || Object.keys(t?.movedByDestTier ?? {}).some((k) => k !== "untracked");

/** True if any tier in a day bucket has real attribution. */
export const dayHasAttribution = (d) => Object.values(d?.tiers ?? {}).some(cellHasAttribution);

/**
 * Count days in `days` at or after `from` (all days when `from` is falsy),
 * and how many of them carry real attribution.
 */
export const coverageFor = (days, from) => {
  let attributedDays = 0;
  let totalDays = 0;
  for (const d of days ?? []) {
    if (from && d.date < from) continue;
    totalDays++;
    if (dayHasAttribution(d)) attributedDays++;
  }
  return { attributedDays, totalDays };
};

/** Earliest day carrying real attribution, or null if none do yet. */
export const firstAttributedDate = (days) => {
  for (const d of days ?? []) if (dayHasAttribution(d)) return d.date;
  return null;
};
