import { tierDisplayLabel } from "./geometry";
import { netWalletsOf, type NetField } from "./net";

export type NetByTierRow = { label: string; name: string; value: number; has: boolean };

/**
 * One bar per tier for "Net wallet change by tier": joined minus left. `has` is
 * false for every bar when the wallet-crossings feed (holder-transitions) is
 * missing, so the chart is skipped rather than drawing zero-length bars.
 */
export const netByTierRows = (
  fields: readonly (NetField & { label: string })[],
  hasTransitions: boolean,
): NetByTierRow[] =>
  fields.map((f) => ({ label: f.label, name: tierDisplayLabel(f.label), value: netWalletsOf(f), has: hasTransitions }));

/** Shown above the net-by-tier chart when a single chain is selected: crossings are never split by chain. */
export const ALL_CHAIN_CROSSINGS_NOTE =
  "Tier sizes are for this chain; wallet moves between tiers (these bars) are tracked across all chains combined.";
