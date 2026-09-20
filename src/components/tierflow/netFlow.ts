import type { Cause, Migration } from "./useFlowField";

// Net-flow derivation for the distribution chart's default ("level 1") view.
//
// Both modes used to draw every gross flow at once: two lines per counterpart
// tier in Wallets mode, six lines in TEL mode. What a reader wants first is
// the NET for the selected period; the gross split is one click away. This
// module is the pure arithmetic behind that — no React, no DOM, no colors
// (it returns a semantic tone and lets the view decide the palette), so it
// can be unit-tested directly.

/** Semantic meaning of a flow, mapped to the chart's palette by the view. */
export type FlowTone = "positive" | "negative" | "neutral";

export type NetMigration = {
  counterpart: string;
  gained: number;
  lost: number;
  net: number;
  /** Direction of the DOMINANT side — what the net actually represents. */
  up: boolean;
  side: "left" | "right";
};

/**
 * Collapses a tier's per-counterpart migrations into one net figure each,
 * ordered by magnitude.
 *
 * Netting the two directions is sound because, for any FIXED counterpart, the
 * gained and lost entries always carry OPPOSITE `up` values — that falls out
 * of useFlowField's own definitions (`gained: up = tierIndex(src) > index` vs
 * `lost: up = tierIndex(dest) < index`; one counterpart index cannot sit on
 * both sides of the same comparison). So the two counts already mean "grew"
 * and "shrank" in opposite directions and subtract meaningfully.
 *
 * Zero-net counterparts are KEPT (net: 0) rather than filtered out: equal
 * traffic both ways is real movement, and silently dropping it would hide
 * churn that does occur in practice. Only the canvas skips drawing them.
 */
export const netMigrationsFor = (migrations: Migration[]): NetMigration[] => {
  const byCounterpart = new Map<string, { gained: number; lost: number; gainedUp: boolean | null; lostUp: boolean | null }>();
  for (const m of migrations) {
    const e = byCounterpart.get(m.counterpart) ?? { gained: 0, lost: 0, gainedUp: null, lostUp: null };
    if (m.gained) { e.gained += m.count; e.gainedUp = m.up; }
    else { e.lost += m.count; e.lostUp = m.up; }
    byCounterpart.set(m.counterpart, e);
  }
  return [...byCounterpart.entries()]
    .map(([counterpart, e]) => {
      const net = e.gained - e.lost;
      // Ties fall back to the gained side.
      const dominantUp = e.gained >= e.lost ? e.gainedUp : e.lostUp;
      return {
        counterpart, gained: e.gained, lost: e.lost, net,
        up: dominantUp ?? false,
        side: net >= 0 ? ("left" as const) : ("right" as const),
      };
    })
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
};

export type NetCause = {
  key: SideTileKey;
  label: string;
  inV: number;
  outV: number;
  net: number;
  tone: FlowTone;
  inLabel: string;
  outLabel: string;
};

/**
 * TEL-mode equivalent: nets each cause CATEGORY (inflow minus outflow) rather
 * than drawing both directions of all four at once.
 *
 * LP flows are neutral — providing/removing liquidity reallocates holdings, it
 * is not a market buy or sale. DEX swaps and CEX deposits keep signed tones.
 */
export const netCausesFor = (cause: Cause): NetCause[] => {
  const mk = (
    key: NetCause["key"], label: string, inV: number, outV: number,
    inLabel: string, outLabel: string, forceNeutral = false,
  ): NetCause => {
    const net = inV - outV;
    return { key, label, inV, outV, net, tone: forceNeutral ? "neutral" : net >= 0 ? "positive" : "negative", inLabel, outLabel };
  };
  return [
    mk("dex", "DEX swaps", cause.boughtDexSwap, cause.dexSwap, "bought on DEX", "sold on DEX"),
    mk("lp", "LP", cause.boughtDexLp, cause.dexLp, "unstaked from LP", "added to LP", true),
    mk("cex", "Exchanges", cause.boughtCex, cause.cex, "withdrawn from exchanges", "deposited to exchanges"),
    // Wallet-to-wallet is redistribution in BOTH directions — never evidence
    // of buying or selling, so it stays neutral regardless of sign.
    mk("wallet", "Other wallets", cause.receivedWallet, cause.moved, "received from other wallets", "moved to other wallets", true),
  ];
};

/** Which side column a cause-pivot click came from. */
export type SideTileSide = "in" | "out";
/** Shared key space for side tiles (OUT's raw field is `moved`, normalized here). */
export type SideTileKey = "dex" | "lp" | "cex" | "wallet";

export type SideTileSelection = { side: SideTileSide; key: SideTileKey };

/**
 * Per-tier TEL amount for a selected side tile. Left (in) tiles read inflow
 * fields; right (out) tiles read outflow fields. Wallet-out uses `moved`.
 */
export const valueForSideTile = (
  cause: Cause,
  side: SideTileSide,
  key: SideTileKey,
): number => {
  if (side === "in") {
    if (key === "dex") return cause.boughtDexSwap;
    if (key === "lp") return cause.boughtDexLp;
    if (key === "cex") return cause.boughtCex;
    return cause.receivedWallet;
  }
  if (key === "dex") return cause.dexSwap;
  if (key === "lp") return cause.dexLp;
  if (key === "cex") return cause.cex;
  return cause.moved;
};

export const SIDE_TILE_LABELS: Record<SideTileSide, Record<SideTileKey, string>> = {
  in: {
    dex: "Bought on DEX",
    lp: "Unstaked from LP",
    cex: "From exchange",
    wallet: "From wallet",
  },
  out: {
    dex: "Sold on DEX",
    lp: "Added to LP",
    cex: "To exchange",
    wallet: "To wallet",
  },
};

/** Row index in the side column (0 = DEX swap, 1 = LP, 2 = exchange, 3 = wallet). */
export const sideTileRowIndex = (key: SideTileKey): number =>
  (key === "dex" ? 0 : key === "lp" ? 1 : key === "cex" ? 2 : 3);

export type SideTileContribution = { label: string; value: number; share: number };

/** Tiers with a positive contribution to the selected side tile, biggest first. */
export const sideTileContributions = (
  fields: ReadonlyArray<{ label: string; cause: Cause }>,
  side: SideTileSide,
  key: SideTileKey,
): SideTileContribution[] => {
  const rows = fields
    .map((f) => ({ label: f.label, value: valueForSideTile(f.cause, side, key) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? r.value / total : 0 }));
};

export type PressureTotals = { bought: number; sold: number; net: number };

/**
 * Buy pressure (DEX buys + exchange withdrawals) minus sell pressure
 * (DEX sells + exchange deposits). Excludes wallet↔wallet and LP.
 * When `selected` is set, scopes to that tier's cause; otherwise sums all fields.
 */
export const retailDemandFor = (
  fields: ReadonlyArray<{ cause: Cause }>,
  selected: Cause | null = null,
): PressureTotals | null => {
  if (selected) {
    if (!selected.hasInData && !selected.hasData) return null;
    const bought = selected.boughtDex + selected.boughtCex;
    const sold = selected.dex + selected.cex;
    return { bought, sold, net: bought - sold };
  }
  let bought = 0;
  let sold = 0;
  let hasAny = false;
  for (const f of fields) {
    if (f.cause.hasInData) { bought += f.cause.boughtDex + f.cause.boughtCex; hasAny = true; }
    if (f.cause.hasData) { sold += f.cause.dex + f.cause.cex; hasAny = true; }
  }
  return hasAny ? { bought, sold, net: bought - sold } : null;
};

/** Snapshot-truth TEL delta for one tier row; null when no baseline. */
export const tierNetTel = (
  row: { totalBalance: number; previousTotalBalance?: number | null } | null | undefined,
): number | null => {
  if (!row || row.previousTotalBalance == null) return null;
  return row.totalBalance - row.previousTotalBalance;
};

/** Tier-scoped DEX swap bought/sold (same fields as the DEX side tiles). */
export const tierDexActivity = (cause: Cause | null | undefined): PressureTotals | null => {
  if (!cause) return null;
  const bought = cause.boughtDexSwap;
  const sold = cause.dexSwap;
  if (bought === 0 && sold === 0) return null;
  return { bought, sold, net: bought - sold };
};
