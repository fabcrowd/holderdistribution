/** Short on-screen column labels for the Wallets view; the explanations live in tooltips. */
export type WalletColumnKey = "joined" | "wallets" | "left";

export type WalletColumn = { key: WalletColumnKey; label: string; tip: string };

/**
 * Phrase for the window the flow figures actually cover (the transitions /
 * outflows window, which can differ from the page range), e.g. "from Jan 1 to
 * Oct 30". Falls back to "over the selected period" when the feed has no dates.
 */
export const periodPhrase = (
  window: { from: string; to: string } | null | undefined,
  fmtDay: (ymd: string) => string = (s) => s,
): string => (window ? `from ${fmtDay(window.from)} to ${fmtDay(window.to)}` : "over the selected period");

/** Table sheet description: net is in minus out over the flows window, never a snapshot delta. */
export const tableDescription = (asOfDate: string | null, period: string): string =>
  `${asOfDate ? `Flows as of ${asOfDate}. ` : ""}Net = in minus out ${period}.`;

/** Net is always in minus out over the period, never a snapshot delta. */
export const netChangeTip = (period: string, metric: "wallets" | "tel" = "wallets", ticker = "TEL"): string =>
  metric === "wallets" ? `Net = joined - left ${period}.` : `Net = ${ticker} in - ${ticker} out ${period}.`;

export const walletColumns = (period: string, ticker = "TEL"): Record<WalletColumnKey, WalletColumn> => ({
  joined: { key: "joined", label: "Joined", tip: `Wallets that moved into this balance range ${period}.` },
  wallets: { key: "wallets", label: "Wallets", tip: `Wallets holding this much ${ticker} today. The bar inside each tile grows with the number of wallets (log scale).` },
  left: { key: "left", label: "Left", tip: `Wallets that moved out of this balance range ${period}.` },
});
