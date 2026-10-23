import type { FlowWindow, WalletFlowsKnownWallet } from "@/lib/walletFlowsTypes";

/**
 * Pure filter/sort for the gated Telcoin-linked wallets table, kept out of the
 * component so it is unit-testable and contains no data of its own.
 */
export type WalletSortKey = "label" | "balance" | FlowWindow;
export type SortDir = "asc" | "desc";

export const DEFAULT_WALLET_SORT: { key: WalletSortKey; dir: SortDir } = { key: "90d", dir: "desc" };

const value = (w: WalletFlowsKnownWallet, key: WalletSortKey): number | string =>
  key === "label" ? w.label.toLowerCase() : key === "balance" ? w.balance : w.sellVenue[key] ?? 0;

export const filterWallets = (
  rows: WalletFlowsKnownWallet[],
  { query = "", onlySelling = false }: { query?: string; onlySelling?: boolean },
): WalletFlowsKnownWallet[] => {
  const q = query.trim().toLowerCase();
  return rows.filter((w) => {
    if (onlySelling && !(w.sellVenue["90d"] > 0)) return false;
    if (!q) return true;
    return (
      w.label.toLowerCase().includes(q) ||
      w.group.toLowerCase().includes(q) ||
      w.address.toLowerCase().includes(q) ||
      w.verdict.toLowerCase().includes(q)
    );
  });
};

export const sortWallets = (
  rows: WalletFlowsKnownWallet[],
  key: WalletSortKey,
  dir: SortDir,
): WalletFlowsKnownWallet[] => {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a, key);
    const vb = value(b, key);
    const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    // Stable, readable tiebreak: label A→Z regardless of direction.
    return cmp !== 0 ? cmp * sign : a.label.localeCompare(b.label);
  });
};

/** Clicking the active column flips it; a new column starts at its natural order. */
export const nextSort = (
  current: { key: WalletSortKey; dir: SortDir },
  key: WalletSortKey,
): { key: WalletSortKey; dir: SortDir } =>
  current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "label" ? "asc" : "desc" };

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export type VerdictTone = "selling" | "inactive" | "neutral";
export const verdictTone = (v: string): VerdictTone =>
  v.startsWith("selling") ? "selling" : v.startsWith("inactive") ? "inactive" : "neutral";
