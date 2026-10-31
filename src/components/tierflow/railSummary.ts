import type { TierField } from "./useFlowField";
import { netCausesFor, netMigrationsFor, valueForSideTile, type SideTileKey } from "./netFlow";
import { ALL_FLOWS_AVAILABLE, netDisplay, netOf, type FlowAvailability } from "./net";
import { DEFAULT_FORMATTERS, type Formatters } from "./format";

/**
 * Pure data behind the Tier flows detail rail and its table sheet. No React,
 * no colours: callers map `tone` to the palette. Net is in minus out over the
 * period (see ./net), never a snapshot delta.
 */

type Metric = "wallets" | "tel";
type Tone = "positive" | "negative" | "neutral";
export type RailField = Pick<TierField, "label" | "index" | "row" | "cause" | "verdict" | "addedCount" | "removedCount" | "migrations">;
export type Suppressed = { count?: string | null; balance?: string | null };

const toneOf = (v: number): Tone => (v === 0 ? "neutral" : v > 0 ? "positive" : "negative");

// ---- Empty-state ranking -------------------------------------------------

export type RankedTier = { label: string; index: number; net: number | null; direction: "up" | "down" | "flat" };

/** Tiers by |net| desc (net = in minus out), ties by tier index. A null net (feed missing) ranks as 0. */
export const rankTiersByNet = (fields: readonly RailField[], metric: Metric, avail: FlowAvailability = ALL_FLOWS_AVAILABLE): RankedTier[] =>
  fields
    .map((f) => {
      const net = netOf(metric, f, avail);
      return { label: f.label, index: f.index, net, direction: net === null || net === 0 ? ("flat" as const) : net > 0 ? ("up" as const) : ("down" as const) };
    })
    .sort((a, b) => {
      const diff = Math.abs(b.net ?? 0) - Math.abs(a.net ?? 0);
      return diff !== 0 ? diff : a.index - b.index;
    });

// ---- KPIs ------------------------------------------------------------------

export type Kpi = { key: "wallets" | "tel" | "netWallets" | "netTel"; label: string; text: string; tone: Tone };
type KpiOptions = { ticker?: string; fmt?: Formatters; avail?: FlowAvailability };

/** Net text for a table/KPI cell: "—" when the feed is missing, "0" for zero, else signed. */
const netText = (value: number | null, f: (n: number) => string, fmt: Formatters): string =>
  value === null ? netDisplay(null, f).text : value === 0 ? "0" : fmt.signed(value, f);

/** Four KPIs, the active metric's pair first. */
export const tierKpis = (field: RailField, metric: Metric, opts: KpiOptions = {}): Kpi[] => {
  const { ticker = "TEL", fmt = DEFAULT_FORMATTERS, avail = ALL_FLOWS_AVAILABLE } = opts;
  // A signed number; an exact zero reads "0"; a missing feed reads "—".
  const net = (value: number | null, f: (n: number) => string): { text: string; tone: Tone } => ({
    text: netText(value, f, fmt),
    tone: value === null ? "neutral" : toneOf(value),
  });
  const wallets: Kpi = { key: "wallets", label: "Wallets now", text: field.row ? fmt.fmtInt(field.row.count) : "—", tone: "neutral" };
  const tel: Kpi = { key: "tel", label: `${ticker} held now`, text: field.row ? fmt.fmtTel(field.row.totalBalance) : "—", tone: "neutral" };
  const netWallets: Kpi = { key: "netWallets", label: "Net wallets", ...net(netOf("wallets", field, avail), fmt.fmtInt) };
  const netTel: Kpi = { key: "netTel", label: `Net ${ticker}`, ...net(netOf("tel", field, avail), fmt.fmtTel) };
  return metric === "wallets" ? [wallets, netWallets, tel, netTel] : [tel, netTel, wallets, netWallets];
};

// ---- Flow summary rows -------------------------------------------------------

export type FlowSummaryRow = {
  key: "buy" | "sell" | "redistribution" | "arrived" | "left";
  label: string;
  icon: "up" | "down" | "swap";
  tone: Tone;
  value: number;
  inValue?: number;
  outValue?: number;
  text: string;
};

export const flowSummaryRows = (field: RailField, metric: Metric, fmt: Formatters = DEFAULT_FORMATTERS): FlowSummaryRow[] => {
  if (metric === "wallets") {
    return [
      { key: "arrived", label: "Arrived", icon: "up", tone: "positive", value: field.addedCount, text: fmt.signed(field.addedCount, fmt.fmtInt) },
      { key: "left", label: "Left", icon: "down", tone: "negative", value: field.removedCount, text: fmt.signed(-field.removedCount, fmt.fmtInt) },
    ];
  }
  const c = field.cause;
  const buy = c.boughtDexSwap + c.boughtCex; // LP is Redistribution, not Buy
  const sell = c.dexSwap + c.cex; // LP adds are not sales (same rule as Cause.sold)
  const redistIn = c.boughtDexLp + c.receivedWallet;
  const redistOut = c.dexLp + c.moved;
  return [
    { key: "buy", label: "Buy", icon: "up", tone: "positive", value: buy, text: fmt.signed(buy, fmt.fmtTel) },
    { key: "sell", label: "Sell", icon: "down", tone: "negative", value: sell, text: fmt.signed(-sell, fmt.fmtTel) },
    {
      key: "redistribution", label: "Redistribution", icon: "swap", tone: "neutral", value: redistIn + redistOut,
      inValue: redistIn, outValue: redistOut,
      text: `${fmt.signed(redistIn, fmt.fmtTel)} / ${fmt.signed(-redistOut, fmt.fmtTel)}`,
    },
  ];
};

export const verdictTag = (verdict: RailField["verdict"]): string | null =>
  verdict === "sold" ? "mostly Sell" : verdict === "relocated" ? "mostly Redistribution" : null;

// ---- Top gross flows ----------------------------------------------------------

export type Counterpart = { key: string; label: string; gross: number; net: number; text: string };

/** Biggest counterparts by gross (in + out), zero-net ones included. */
export const topCounterparts = (field: RailField, metric: Metric, n: number, fmt: Formatters = DEFAULT_FORMATTERS): Counterpart[] => {
  const all: Counterpart[] = metric === "wallets"
    ? netMigrationsFor(field.migrations).map((m) => ({
      key: m.counterpart, label: m.counterpart, gross: m.gained + m.lost, net: m.net,
      text: `${fmt.signed(m.gained, fmt.fmtInt)} / ${fmt.signed(-m.lost, fmt.fmtInt)}`,
    }))
    : netCausesFor(field.cause).map((c) => ({
      key: c.key, label: c.label, gross: c.inV + c.outV, net: c.net,
      text: `${fmt.signed(c.inV, fmt.fmtTel)} / ${fmt.signed(-c.outV, fmt.fmtTel)}`,
    }));
  return all.filter((c) => c.gross > 0).sort((a, b) => b.gross - a.gross).slice(0, n);
};

// ---- Table rows ----------------------------------------------------------------

export type WalletsFlowRow = { from: string; to: string; wallets: number };

/** One row per crossing: only the departing side (`gained: false`) is listed. */
export const walletsFlowRows = (fields: readonly RailField[]): WalletsFlowRow[] =>
  [...fields]
    .sort((a, b) => a.index - b.index)
    .flatMap((f) =>
      f.migrations
        .filter((m) => !m.gained && m.count > 0)
        .sort((a, b) => b.count - a.count)
        .map((m) => ({ from: f.label, to: m.counterpart, wallets: m.count })),
    );

export type TelFlowRow = { tier: string; endpoint: string; direction: "In" | "Out"; cls: "Buy" | "Sell" | "Redistribution"; amount: number };

const ENDPOINTS: { key: SideTileKey; label: string }[] = [
  { key: "dex", label: "DEX" },
  { key: "lp", label: "Liquidity pool" },
  { key: "cex", label: "Exchange" },
  { key: "wallet", label: "Wallet" },
];

export const telFlowRows = (fields: readonly RailField[]): TelFlowRow[] => {
  const rows: TelFlowRow[] = [];
  for (const f of [...fields].sort((a, b) => a.index - b.index)) {
    for (const side of ["in", "out"] as const) {
      for (const e of ENDPOINTS) {
        const amount = valueForSideTile(f.cause, side, e.key);
        if (amount <= 0) continue;
        const market = e.key === "dex" || e.key === "cex";
        rows.push({
          tier: f.label, endpoint: e.label, direction: side === "in" ? "In" : "Out", amount,
          cls: !market ? "Redistribution" : side === "in" ? "Buy" : "Sell",
        });
      }
    }
  }
  return rows;
};

export type TierSummaryRow = Record<string, string>;

export const tierSummaryRows = (
  fields: readonly RailField[],
  metric: Metric,
  fmt: Formatters = DEFAULT_FORMATTERS,
  avail: FlowAvailability = ALL_FLOWS_AVAILABLE,
): TierSummaryRow[] =>
  [...fields].sort((a, b) => a.index - b.index).map((f): TierSummaryRow => {
    if (metric === "wallets") {
      const net = netOf("wallets", f, avail);
      return {
        tier: f.label,
        wallets: f.row ? fmt.fmtInt(f.row.count) : "—",
        net: netText(net, fmt.fmtInt, fmt),
        arrived: fmt.signed(f.addedCount, fmt.fmtInt),
        left: fmt.signed(-f.removedCount, fmt.fmtInt),
      };
    }
    const net = netOf("tel", f, avail);
    const [buy, sell, redist] = flowSummaryRows(f, "tel", fmt);
    return {
      tier: f.label,
      held: f.row ? fmt.fmtTel(f.row.totalBalance) : "—",
      net: netText(net, fmt.fmtTel, fmt),
      buy: fmt.fmtTel(buy.value),
      sell: fmt.fmtTel(sell.value),
      redistIn: fmt.fmtTel(redist.inValue ?? 0),
      redistOut: fmt.fmtTel(redist.outValue ?? 0),
    };
  });
