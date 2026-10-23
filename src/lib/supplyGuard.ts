/**
 * The Supply donut's segments are a partition of total supply, so they must
 * sum to it. When they don't (a stale or half-refreshed snapshot — e.g. the
 * Oct 2026 feed summed to 102.87B against 100B), printing "Segments sum to
 * 102.87B" just hands the reader an unexplained contradiction. Past a small
 * tolerance we say plainly that the figures are being reconciled instead.
 */
export const RECONCILE_TOLERANCE = 0.005; // 0.5% of total supply

export type ReconcileStatus =
  | { kind: "ok"; drift: number }
  | { kind: "reconciling"; drift: number; driftPct: number };

export function reconcileStatus(partitionSum: number, totalSupply: number): ReconcileStatus {
  const drift = partitionSum - totalSupply;
  if (!Number.isFinite(partitionSum) || !Number.isFinite(totalSupply) || totalSupply <= 0) {
    return { kind: "reconciling", drift: Number.NaN, driftPct: Number.NaN };
  }
  const driftPct = Math.abs(drift) / totalSupply;
  return driftPct > RECONCILE_TOLERANCE ? { kind: "reconciling", drift, driftPct } : { kind: "ok", drift };
}
