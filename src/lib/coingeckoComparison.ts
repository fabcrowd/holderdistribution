/**
 * CoinGecko row on Supply › Reconciliation.
 *
 * The feed publishes `coingeckoCirculating` per project (scripts/reconcile-supply.js).
 * A missing or non-positive figure hides the row. There is no stand-in number.
 */
export type CoingeckoComparison = {
  reported: number;
  delta: number;
};

export const coingeckoComparison = (
  circulating: number | null | undefined,
  reported: number | null | undefined,
): CoingeckoComparison | null => {
  if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return null;
  if (typeof circulating !== "number" || !Number.isFinite(circulating)) return null;
  return { reported, delta: circulating - reported };
};
