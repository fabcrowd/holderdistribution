import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { uniqueWalletCount } from "@/lib/holderCounts";

export const DASH = "—";

/** `holders` is the unique-wallet count (labelled "Unique wallets" on the card). */
export type CardStats = { holders: string; retailShare: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const countFormat = new Intl.NumberFormat("en-US");

/**
 * Retail wallet count for a token's holders-lite.json: views.combined.metrics.holderCount
 * (the per-chain count the history charts and the terminal use), falling back to
 * overlap.uniqueCount when absent. Null when neither is present.
 */
const retailWalletCount = (snap: HolderLiteSnapshot | null | undefined): number | null => {
  const m = snap?.views?.combined?.metrics;
  return num(m?.holderCount) ?? uniqueWalletCount(snap);
};

/**
 * Landing-card stats from a token's existing holders-lite.json: retail wallets
 * (see retailWalletCount) and retail share of supply (views.combined.metrics.totalBalance /
 * totals.totalSupply, the same inputs as the terminal's "Retail Held" tile).
 * Each stat falls back to "—" on its own.
 */
export const cardStats = (snap: HolderLiteSnapshot | null | undefined): CardStats => {
  const count = retailWalletCount(snap);
  const held = num(snap?.views?.combined?.metrics?.totalBalance);
  const supply = num(snap?.totals?.totalSupply);
  return {
    holders: count === null ? DASH : countFormat.format(count),
    retailShare: held === null || supply === null || supply <= 0 ? DASH : `${((held / supply) * 100).toFixed(1)}%`,
  };
};

export type BoardTotals = { tokens: number; wallets: string; chains: number };

/**
 * Landing stat band: token count, retail wallets summed across tokens (DASH unless
 * every snapshot has a count), and unique chain keys across all tokens.
 */
export const boardTotals = (
  snaps: ReadonlyArray<HolderLiteSnapshot | null | undefined>,
  chainKeys: ReadonlyArray<ReadonlyArray<string>>,
): BoardTotals => {
  const counts = snaps.map(retailWalletCount);
  const complete = counts.every((c): c is number => c !== null);
  const sum = complete ? counts.reduce((acc, c) => acc + c, 0) : null;
  return {
    tokens: snaps.length,
    wallets: sum === null ? DASH : countFormat.format(sum),
    chains: new Set(chainKeys.flat()).size,
  };
};

const PERCENT_RE = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/;

/** Numeric width (0..100) of a "66.6%" style stat for a meter; null when not parseable. */
export const percentWidth = (text: string | null | undefined): number | null => {
  const match = text == null ? null : PERCENT_RE.exec(text);
  if (match === null) return null;
  return Math.min(100, Math.max(0, Number(match[1])));
};
