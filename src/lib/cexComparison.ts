/** `comparison` block of cex-flows.json (scripts/lib/cexFlows.js). Older feeds do not carry it. */
export type CexFlowComparison = {
  available: boolean;
  reason?: string;
  windowDays?: number;
  previous?: unknown;
  current?: unknown;
};

/**
 * Whether the cex-flows snapshot-over-snapshot change may stand in for the selected range
 * when cex-balance-history cannot supply it.
 *  - key absent (older feed): unchanged behavior, usable.
 *  - available false: previousBalance equals currentBalance, so the 0 is not a measurement.
 *  - available true: the delta spans one day, so it only matches a one-day range.
 */
export const cexFlowsFallbackUsable = (comparison: CexFlowComparison | null | undefined, rangeDays: number): boolean => {
  if (comparison == null) return true;
  if (comparison.available !== true) return false;
  return rangeDays === 1;
};
