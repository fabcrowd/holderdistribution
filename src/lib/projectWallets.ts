/**
 * Types + pure helpers for the gated Developer wallets view
 * (src/components/projectWallets/ProjectWalletsView.tsx). The report is
 * data/<slug>/ledger/ledger.json from scripts/build-ledger.js, served only by
 * the forensics gate ("project-ledger"). See docs/LEDGER.md.
 */
import type { TxTypeInfo } from "@/lib/txTypes";

export const LEDGER_WINDOWS = ["24h", "72h", "30d", "90d"] as const;
export type LedgerWindow = (typeof LEDGER_WINDOWS)[number];
export const DEFAULT_LEDGER_WINDOW: LedgerWindow = "30d";

export type LedgerEvent = {
  chain: string;
  hash: string;
  time: number;
  date: string;
  type: string;
  direction: "in" | "out";
  wallet: string;
  walletLabel: string;
  counterparty: string;
  counterpartyLabel: string | null;
  asset: "token" | "stable";
  symbol: string;
  amount: number;
  reason: string;
  internal?: boolean;
  headline?: boolean;
};

type Destination = { address: string; label: string | null; asset: string; symbol: string; type: string; count: number; amount: number; lastHash: string | null; lastTime: number };

export type WindowSummary = {
  from: string;
  to: string;
  devSold: { dex: number; cex: number; botDevShare: number; total: number };
  sellCount: number;
  botSaleCount: number;
  botSold: number;
  sellDays: number;
  internal: { count: number; amount: number };
  received: number;
  payments: {
    stableOut: number;
    stableOutCount: number;
    stableIn: number;
    stableInCount: number;
    bySymbol: Record<string, number>;
    topStableRecipients: Destination[];
    topTokenDestinations: Destination[];
  };
  byType: Record<string, { count: number; amount: number }>;
};

export type LedgerPattern = { kind: string; wallet: string; walletLabel: string; count: number; description: string; sampleHashes: string[] };

export type LedgerReport = {
  version: 1;
  slug: string;
  name: string;
  ticker: string;
  generated: string;
  windows: LedgerWindow[];
  defaultWindow: LedgerWindow;
  historyDays: number;
  rule: string;
  txTypes: Record<string, TxTypeInfo>;
  coverage: Record<string, { status?: string; [k: string]: unknown }>;
  crossCheck: unknown;
  botCluster: null | {
    label: string;
    chain: string;
    addresses: string[];
    devShare: number;
    evidence: unknown[];
    windows: Record<string, { sold: number; sales: number; devShare: number }>;
    recentSales: { hash: string; time: number; amount: number; venue?: string }[];
  };
  byWindow: Partial<Record<LedgerWindow, WindowSummary>>;
  headlines: Partial<Record<LedgerWindow, string[]>>;
  developerWallets: {
    address: string;
    label: string;
    group: string | null;
    entityClass: string | null;
    chains: string[];
    windows: Partial<Record<LedgerWindow, { sold: number; stableOut: number; internal: number; txs: number }>>;
    lastActivity: string | null;
  }[];
  daily: ({ date: string; devSold: number; botSold: number; botDevShare: number } & Record<string, number | string>)[];
  patterns: LedgerPattern[];
  events: LedgerEvent[];
  eventsTruncated: boolean;
};

export type BotProceedsReport = {
  version: 1;
  slug: string;
  generated: string;
  status: string;
  rule?: string;
  evidence?: { summary: string; devShare: number; funding: { source: string; label: string; address: string | null; amount: number; txs: string[]; counted: boolean }[] };
  detection?: { rule?: string; candidates: { chain: string; address: string; label: string | null; fundings: number; amount: number; funders: string[]; shareOfOutflow: number; sampleHashes: string[]; reason: string }[] };
  summary?: { salesTraced: number; tokenSold: number; tokenSoldDevShare: number; byAsset: Record<string, { proceeds: number; devAttributed: number; sales: number }>; destinations: { kind?: string; label?: string; amount: number; devAttributed: number; symbol: string; sampleHashes: string[] }[] };
};

const WINDOW_DAYS: Record<LedgerWindow, number> = { "24h": 1, "72h": 3, "30d": 30, "90d": 90 };

/** Page range (RANGE_OPTIONS days) -> the ledger window that covers it best; anything over 90 days -> 90d. */
export function windowForRange(rangeDays: number | null | undefined): LedgerWindow {
  if (!rangeDays || !Number.isFinite(rangeDays)) return DEFAULT_LEDGER_WINDOW;
  for (const w of LEDGER_WINDOWS) if (rangeDays <= WINDOW_DAYS[w]) return w;
  return "90d";
}

export const windowDays = (w: LedgerWindow) => WINDOW_DAYS[w];

export type FlowEdge = { key: string; label: string; amount: number; kind: "sell" | "payment" | "move" | "internal"; tip: string };

/** Flow map edges out of the developer wallets for one window, biggest first; zero edges dropped. */
export function flowEdges(s: WindowSummary | undefined, ticker: string): FlowEdge[] {
  if (!s) return [];
  const by = (t: string) => s.byType?.[t]?.amount ?? 0;
  const edges: FlowEdge[] = [
    { key: "dex", label: "DEX sales", amount: s.devSold.dex, kind: "sell", tip: `${ticker} swapped on a DEX by a developer wallet.` },
    { key: "cex", label: "Exchange deposits", amount: s.devSold.cex, kind: "sell", tip: `${ticker} sent to an exchange deposit or hot wallet.` },
    { key: "bot", label: "Bot cluster (dev share)", amount: s.devSold.botDevShare, kind: "sell", tip: "Only the developer-funded share of the bot cluster's sales counts." },
    { key: "transfer_out", label: "Other wallets", amount: by("transfer_out"), kind: "move", tip: `${ticker} sent to an unlabelled wallet (not counted as selling).` },
    { key: "bridge", label: "Bridges", amount: by("bridge"), kind: "move", tip: "Moved to another chain." },
    { key: "custody", label: "Custody / escrow", amount: by("custody"), kind: "move", tip: "BitGo / Anchorage and escrow contracts: custody, not a sale." },
    { key: "staking", label: "Staking", amount: by("staking"), kind: "move", tip: "Staking and reward contracts." },
    { key: "bot_funding", label: "Bot funding", amount: by("bot_funding"), kind: "move", tip: "Developer wallets funding the bot cluster (its sales count pro-rata)." },
    { key: "internal", label: "Internal shuffles", amount: s.internal.amount, kind: "internal", tip: "Between developer wallets: noted, never counted." },
  ];
  return edges.filter((e) => e.amount > 0).sort((a, b) => b.amount - a.amount);
}

/** "How often": sale days / window days, as a short phrase. */
export function sellFrequency(s: WindowSummary | undefined, w: LedgerWindow): string {
  if (!s || (s.sellCount === 0 && s.botSaleCount === 0)) return "No selling";
  const days = WINDOW_DAYS[w];
  return `${s.sellDays} of ${days} day${days === 1 ? "" : "s"}`;
}

export const eventsInWindow = (events: LedgerEvent[], w: LedgerWindow, nowSec: number): LedgerEvent[] =>
  events.filter((e) => e.time >= nowSec - WINDOW_DAYS[w] * 86400);

export const dailyInWindow = (daily: LedgerReport["daily"], w: LedgerWindow) => daily.slice(-WINDOW_DAYS[w]);

/** The Supply view shows the Developer wallets tab (#supply/project-wallets) for flagged projects only. */
export const showsProjectWallets = (cfg: { capabilities?: { projectWallets?: boolean } } | null | undefined): boolean => cfg?.capabilities?.projectWallets === true;
