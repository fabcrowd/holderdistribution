/**
 * Round a breakdown of parts to integers such that they sum EXACTLY to a given
 * total, with every part non-negative.
 *
 * Used by generate-tier-outflows.js to emit per-counterparty-tier breakdowns
 * (`inflowsBySourceTier`, `movedByDestTier`) beside the totals they decompose
 * (`inflows.wallet`, `moved`). A reader who adds the breakdown up must land on
 * the total printed next to it — this project has repeatedly shipped figures
 * that didn't reconcile, so the guarantee is enforced here at the source
 * rather than hoped for in each consumer.
 *
 * Rounding each part independently fails that guarantee twice over: parts
 * below 0.5 round to zero and disappear (losing their value outright), and
 * several parts rounding up can overshoot the total — which, if the residual
 * were dumped into the "untracked" bucket, would surface in the UI as a
 * NEGATIVE amount of unattributed flow.
 *
 * So this uses largest-remainder apportionment (the same method used to
 * allocate seats from vote shares): floor every part, then hand the leftover
 * units one at a time to the parts with the largest fractional remainders.
 * Every part stays within 1 of its true value, none can go negative, and the
 * sum is exact by construction.
 *
 * @param {Record<string, number>} src   raw (unrounded) parts, keyed by tier label or "untracked"
 * @param {number} total                 the already-rounded total the parts must sum to
 * @returns {Record<string, number>}     sparse integer parts summing exactly to `total`
 */
export const reconcileParts = (src, total) => {
  const entries = Object.entries(src ?? {}).filter(([, amt]) => amt > 0);
  // No parts at all: a day scanned before attribution existed, or genuinely no
  // flow. Attribute the whole total to "untracked" rather than inventing tier
  // entries — claiming zero from every tier would read as a real measurement.
  if (entries.length === 0) return total > 0 ? { untracked: total } : {};

  const parts = entries.map(([k, amt]) => ({ k, v: Math.floor(amt), frac: amt - Math.floor(amt) }));
  let deficit = total - parts.reduce((s, p) => s + p.v, 0);
  parts.sort((a, b) => b.frac - a.frac);
  for (let i = 0; deficit > 0 && i < parts.length; i++, deficit--) parts[i].v += 1;
  // Defensive: only reachable if `total` was rounded from a different figure
  // than the parts were derived from. Put it on the largest part, where a
  // sub-TEL adjustment cannot be seen.
  if (deficit !== 0) { parts.sort((a, b) => b.v - a.v); parts[0].v += deficit; }

  const out = {};
  for (const p of parts) if (p.v > 0) out[p.k] = p.v;
  return out;
};
