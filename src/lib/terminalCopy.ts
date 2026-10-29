/**
 * Desktop terminal labels. The overview is the multi-chart screen; each
 * panel's expand icon opens Explore, the same Holders charts one at a time (plus Momentum, which has no
 * Dashboard cell). Ids match `HOLDER_PANEL_IDS` in viewRoute — only the
 * words change, so existing hashes keep working.
 */

export const EXPLORE_HINT =
  "One chart at a time. Holder history, exchange flows, wallet sizes, staking, concentration and exchanges are the overview charts at full size. Momentum is only here.";

export type ExplorePanelCopy = {
  id: string;
  label: string;
  /** Tab tooltip. Names the Dashboard chart this section repeats, when it does. */
  hint: string;
};

export const HOLDER_EXPLORE_PANELS: readonly ExplorePanelCopy[] = [
  {
    id: "overview",
    label: "Key numbers",
    hint: "The headline counts. The Dashboard draws these as charts instead of repeating the tiles.",
  },
  {
    id: "concentration",
    label: "Concentration",
    hint: "Same concentration breakdown as the Dashboard, full size.",
  },
  {
    id: "balances",
    label: "Wallet sizes",
    hint: "Same wallet-size chart as the Dashboard, full size.",
  },
  {
    id: "staking",
    label: "Staking",
    hint: "Same staking chart as the Dashboard, full size.",
  },
  {
    id: "growth",
    label: "Momentum",
    hint: "How fast the holder count is moving, and wallets on more than one chain. Not on the Dashboard.",
  },
  {
    id: "trends",
    label: "Holder history",
    hint: "Holder count and balance over time — the Dashboard's Retail wallets and balance charts, full size.",
  },
  {
    id: "flows",
    label: "Exchange flows",
    hint: "Deposits and withdrawals — the Dashboard's Exchange net flow chart, full size.",
  },
  {
    id: "exchanges",
    label: "Exchanges",
    hint: "Per-exchange balances — the Dashboard's Exchange balances table, with history.",
  },
];

/**
 * What "Tier flows" means, shown above the diagram (not only in the info
 * tooltip). `{ticker}` is filled from the active project.
 */
export const TIER_FLOWS_EXPLAINER =
  "Tier flows show wallets moving between balance bands — ranges of {ticker} held — over this period. Green is wallets that arrived in a band, red is wallets that left. That is relocation between bands, not a buy or a sell. Select a band to see which bands they came from and went to.";
