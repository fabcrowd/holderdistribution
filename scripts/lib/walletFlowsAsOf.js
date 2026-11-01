// Report transform for `--as-of` backfills. Balances and USD prices as of a past date cannot be
// read without archive RPC and a historical price source, so they are explicit nulls with a note
// (plan risk table: "Balances/price wrong for historical anchors"). Flow counts (outflows, sell
// venues, bot DEX/CEX sales, large sellers' TEL) are on-chain facts for the window and are kept.

const UNAVAILABLE = (iso) =>
  `as-of ${iso}: no historical price source; priceUsd is null and USD values are null`;

/** Price fields for an as-of run: never the live price. */
export function asOfPrice(iso) {
  return { priceUsd: null, priceSource: UNAVAILABLE(iso) };
}

const nullBalanceRow = (w) => ({
  ...w,
  balance: null,
  balanceDetail: null,
  balanceUsd: null,
  sellVenueUsd90d: null,
});

const nullTotals = (totals) =>
  Object.fromEntries(Object.entries(totals ?? {}).map(([win, t]) => [win, { ...t, usd: null }]));

/**
 * Returns a copy of `report` with balances and USD values nulled, plus `asOf` and notes that say
 * what is and is not historical. The input is not mutated.
 */
export function applyAsOfNulls(report, asOf) {
  const { iso } = asOf;
  return {
    ...report,
    asOf: iso,
    priceUsd: null,
    priceSource: UNAVAILABLE(iso),
    notes: [
      ...(report.notes ?? []),
      `as-of ${iso}: balances and USD values are null (current balances and prices cannot be recovered without archive reads).`,
      "Supply distribution uses the current supply reconciliation, not the as-of date.",
    ],
    telcoinTotals: nullTotals(report.telcoinTotals),
    knownWallets: (report.knownWallets ?? []).map(nullBalanceRow),
    botCluster: report.botCluster ? { ...report.botCluster, balance: null } : report.botCluster,
    largeSellers: (report.largeSellers ?? []).map((s) => ({ ...s, usd: null })),
  };
}
