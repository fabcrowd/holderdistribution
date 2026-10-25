/**
 * What is selected on the Distribution view. One state shared by the tier
 * flow diagram, the "Tiers" table and the net-change bars, so selecting a
 * tier anywhere highlights it everywhere and opens the same detail panel.
 *
 *   tier          a balance tier label ("1M-5M"), or null
 *   sideTile      a cause tile (Bought on DEX, To wallet, …), or null
 *   expandedFlow  second-level disclosure inside the selection: a counterpart
 *                 tier label (Wallets mode) or a cause key (TEL mode)
 *
 * Tier and side-tile pivots are exclusive, EXCEPT the documented 2-step
 * wallet drill: with a tier selected, the "To wallet" / "From wallet" tile
 * keeps the tier and opens its wallet<->wallet attribution.
 */
import type { SideTileSelection } from "@/components/tierflow/netFlow";

export type DistSelection = {
  tier: string | null;
  sideTile: SideTileSelection | null;
  expandedFlow: string | null;
};

export type DistAction =
  | { type: "tier"; label: string }
  /** Select (never toggle off) — table rows / bars when re-clicking should keep it. */
  | { type: "tier-set"; label: string | null }
  | { type: "side"; tile: SideTileSelection }
  | { type: "flow"; key: string }
  | { type: "clear" }
  /** Metric or range changed: expansions and side pivots no longer mean anything. */
  | { type: "reset-mode" };

export const EMPTY_SELECTION: DistSelection = { tier: null, sideTile: null, expandedFlow: null };

const sameTile = (a: SideTileSelection | null, b: SideTileSelection) => !!a && a.side === b.side && a.key === b.key;

export const reduceSelection = (state: DistSelection, action: DistAction): DistSelection => {
  switch (action.type) {
    case "tier":
      return { tier: state.tier === action.label ? null : action.label, sideTile: null, expandedFlow: null };
    case "tier-set":
      return state.tier === action.label && !state.sideTile && !state.expandedFlow
        ? state
        : { tier: action.label, sideTile: null, expandedFlow: null };
    case "side": {
      if (state.tier && action.tile.key === "wallet") {
        const off = sameTile(state.sideTile, action.tile);
        return { tier: state.tier, sideTile: off ? null : action.tile, expandedFlow: off ? null : "wallet" };
      }
      return { tier: null, sideTile: sameTile(state.sideTile, action.tile) ? null : action.tile, expandedFlow: null };
    }
    case "flow":
      return {
        ...state,
        expandedFlow: state.expandedFlow === action.key ? null : action.key,
        // Path-click into "Other wallets" without a direction shows both.
        sideTile: action.key === "wallet" ? null : state.sideTile,
      };
    case "clear":
      return hasSelection(state) ? EMPTY_SELECTION : state;
    case "reset-mode":
      return state.sideTile || state.expandedFlow ? { tier: state.tier, sideTile: null, expandedFlow: null } : state;
  }
};

export const hasSelection = (s: DistSelection) => !!(s.tier || s.sideTile || s.expandedFlow);

/**
 * Share of the tier stack (top → bottom) treated as "on the first screen"
 * when picking a default. The busiest band overall is often the bottom
 * dust tier, which sits below the fold on the 1:1 diagram.
 */
export const DEFAULT_TIER_VISIBLE_FRACTION = 0.7;

export type TierCountRow = { label: string; count: number };

/**
 * Tier to select on first paint so the diagram isn't an empty stack of
 * bars. Prefers the busiest band that still sits in the top
 * `DEFAULT_TIER_VISIBLE_FRACTION` of `order` (the diagram's top-to-bottom
 * labels). With no order, or when that slice is empty, the busiest band.
 * Ties break by label so the pick is stable.
 */
export const defaultTierLabel = (rows: readonly TierCountRow[], order?: readonly string[]): string | null => {
  if (rows.length === 0) return null;
  const byCount = [...rows].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const best = byCount[0];
  if (!order || order.length === 0 || best.count <= 0) return best.label;
  const visibleCount = Math.max(1, Math.ceil(order.length * DEFAULT_TIER_VISIBLE_FRACTION));
  const visible = new Set(order.slice(0, visibleCount));
  const inView = byCount.find((r) => visible.has(r.label) && r.count > 0);
  return (inView ?? best).label;
};

/**
 * Escape clears the selection — unless the key press belongs to something
 * that handles Escape itself: an open popover / tooltip / dialog / menu
 * (Radix closes those first), or a text field.
 */
export const shouldClearOnEscape = (
  e: { key: string; defaultPrevented?: boolean; target?: unknown },
  doc: { querySelector: (sel: string) => unknown } | null,
): boolean => {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = t?.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return false;
  if (
    doc?.querySelector(
      '[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"]',
    )
  )
    return false;
  return true;
};
