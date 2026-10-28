import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

export const DASH = "—";

export type CardStats = { holders: string; retailShare: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Landing-card stats from a token's existing holders-lite.json: holder count
 * (views.combined.metrics.holderCount) and retail share of supply
 * (views.combined.metrics.totalBalance / totals.totalSupply, the same inputs as
 * the terminal's "Retail Held" tile). Each stat falls back to "—" on its own.
 */
export const cardStats = (snap: HolderLiteSnapshot | null | undefined): CardStats => {
  const m = snap?.views?.combined?.metrics;
  const count = num(m?.holderCount);
  const held = num(m?.totalBalance);
  const supply = num(snap?.totals?.totalSupply);
  return {
    holders: count === null ? DASH : new Intl.NumberFormat("en-US").format(count),
    retailShare: held === null || supply === null || supply <= 0 ? DASH : `${((held / supply) * 100).toFixed(1)}%`,
  };
};
