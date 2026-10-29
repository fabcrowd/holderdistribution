/**
 * Which holder-count field each surface reads, and how it is worded.
 *
 * holders-lite.json carries two counts that differ on multi-chain tokens:
 *   - views.<view>.metrics.holderCount: wallets with >0 balance that are not
 *     exchange/treasury/DEX addresses, counted per chain and summed. A wallet
 *     on two chains counts twice in the "combined" view. It matches the
 *     holders-history series, so deltas and trend charts use it ("Retail
 *     wallets").
 *   - overlap.uniqueCount: the same addresses de-duplicated across chains
 *     ("Unique wallets"). Standalone figures with no history to compare
 *     against (landing cards) use it.
 * On a single-chain token the two are equal. The threshold-based
 * `retailHolderCount` in holders-summary.json / holders-history.json
 * (balance >= retail threshold) is a third, smaller figure that the
 * dashboard does not display.
 */
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

export const RETAIL_WALLETS_LABEL = "Retail Wallets";
export const UNIQUE_WALLETS_LABEL = "Unique wallets";

const int = new Intl.NumberFormat("en-US");

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Distinct wallets across all chains, or null when the snapshot has no overlap block. */
export const uniqueWalletCount = (snap: Pick<HolderLiteSnapshot, "overlap"> | null | undefined): number | null =>
  finite(snap?.overlap?.uniqueCount);

/** True when the per-chain sum counts some wallet more than once. */
export const countsWalletsPerChain = (walletCount: number | null, uniqueWallets: number | null): boolean =>
  walletCount !== null && uniqueWallets !== null && uniqueWallets < walletCount;

const EXCHANGE_NOTE =
  "Note: an exchange is a single wallet holding many customers' {ticker}, so its users aren't counted individually here — the true number of people holding {ticker} is higher than this figure.";

/**
 * Tooltip for the Retail Wallets tile. Spells out per-chain counting (with the
 * unique figure) only when it applies; otherwise the plain definition.
 */
export const retailWalletsInfo = (args: {
  ticker: string;
  chains: string;
  walletCount: number | null;
  uniqueWallets: number | null;
}): string => {
  const { ticker, chains, walletCount, uniqueWallets } = args;
  const lead = countsWalletsPerChain(walletCount, uniqueWallets)
    ? `Wallets holding >0 ${ticker} on ${chains}, excluding exchanges and other non-retail addresses. Each chain is counted separately, so a wallet on several chains appears once per chain; ${int.format(uniqueWallets as number)} unique wallets across chains.`
    : `Count of distinct on-chain wallets holding >0 ${ticker} across ${chains}.`;
  return `${lead}\n\n${EXCHANGE_NOTE.replace(/\{ticker\}/g, ticker)}`;
};
