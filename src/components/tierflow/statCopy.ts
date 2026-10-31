/** Tooltip and prompt copy for the stat strip above the tier-flow diagram. Pure, so it is unit-tested. */
export type DemandFigures = { bought: number; sold: number; net: number };
type Fmt = (n: number) => string;

/** Gross TEL that left a tier (or all retail tiers), split by where it went. */
export type GrossOut = { dex: number; cex: number; moved: number };

/** `period` is a phrase from columnCopy.periodPhrase ("from Jan 1 to Oct 30" / "over the selected period"). */
type NetTelTipArgs = { ticker: string; period: string; gross: GrossOut; scope: string | null; fmt: Fmt };

export const netTelTip = ({ ticker, period, gross, scope, fmt }: NetTelTipArgs): string => {
  const where = scope ? `the ${scope} tier` : "retail tiers";
  const net = `${ticker} in minus ${ticker} out ${period}. Includes buys, sells, exchange moves and wallets relocating funds.`;
  const out = `Of the ${ticker} that left ${where}: ${fmt(gross.dex)} sold on DEX, ${fmt(gross.cex)} to exchanges, ${fmt(gross.moved)} moved to other wallets - gross figures, not the net above.`;
  return `${net}\n\n${out}`;
};

export const buySellTip = (demand: DemandFigures | null, fmt: Fmt): string => {
  if (!demand) return "No DEX/exchange activity recorded yet.";
  const lead = demand.net >= 0 ? "More buy than sell pressure" : "More sell than buy pressure";
  return `${lead}, excluding wallet-to-wallet moves.\n\nBuy ${fmt(demand.bought)} (DEX buys + exchange withdrawals) minus sell ${fmt(demand.sold)} (DEX sells + exchange deposits).`;
};

export const dexTip = (tierScoped: boolean): string =>
  tierScoped
    ? "This tier's DEX swaps - same figures as Bought on DEX / Sold on DEX beside the chart."
    : "All wallets, not just retail tiers - a separate figure from the tier detail.";

/** The one visible prompt shown while nothing is selected. */
export const tierPrompt = (metric: "wallets" | "tel", ticker: string, verb: "Click" | "Tap" = "Click"): string =>
  `${verb} a tier to see where its ${metric === "wallets" ? "wallets" : ticker} came from and went.`;
