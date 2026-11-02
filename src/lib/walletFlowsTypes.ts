/**
 * TYPES ONLY for the gated Wallet flows report. The data itself
 * (data/forensics/wallet-flows.json) is served exclusively by the forensics gate
 * function after password verification — never import the JSON from src/ outside
 * the DEV-only loader (src/lib/loadForensicsDev.ts), or it ships in the bundle.
 */
export type FlowWindow = "72h" | "30d" | "90d";
export const FLOW_WINDOWS: FlowWindow[] = ["72h", "30d", "90d"];

export type WalletFlowsDistributionClass = {
  key: string;
  label: string;
  group: string;
  tel: number;
  share: number;
};

export type WalletFlowsKnownWallet = {
  label: string;
  group: string;
  entityClass: string;
  source: string;
  confidence: string;
  address: string;
  chains: string[];
  balance: number;
  balanceDetail: Record<string, number>;
  balanceUsd: number;
  outflows: Record<FlowWindow, Record<string, number>>;
  sellVenue: Record<FlowWindow, number>;
  sellVenueUsd90d: number;
  sampleTxs: string[];
  verdict: string;
};

export type WalletFlowsFundingLink = {
  from: string;
  to: string;
  tel?: number;
  when?: string;
  note?: string;
  onward?: string;
  confidence: string;
  sampleTxs?: string[];
};

export type WalletFlowsSeller = {
  rank: number;
  entity: string;
  addresses: string[];
  chains: string[];
  destination: string;
  tel: number;
  netTel?: number;
  usd: number;
  sampleTx: string | null;
  note?: string;
};

export type WalletFlowsHop = {
  hop: number;
  from: string;
  to: string;
  kind: string;
  venue: string | null;
  mint: string;
  symbol: string | null;
  amount: number;
  sig: string;
  url: string;
  t: string;
};

export type WalletFlowsSaleProceeds = {
  mint: string;
  symbol: string | null;
  raw: string;
  decimals: number;
  amount: number;
  usd: number | null;
  source?: "token" | "native";
};

export type WalletFlowsSale = {
  wallet: string;
  label: string;
  sig: string;
  url: string;
  t: string;
  zbcnSold: number;
  proceeds: WalletFlowsSaleProceeds[];
  proceedsUsd: number | null;
  effectivePriceUsd: number | null;
  onwardStatus: "none-seen" | "partial" | "complete" | "untracked";
  onward: WalletFlowsHop[];
};

export type WalletFlowsSalesJournal = {
  window: string;
  valuedAtReportTime: boolean;
  totals: { count: number; zbcnSold: number; proceedsUsd: number | null };
  sales: WalletFlowsSale[];
};

export type WalletFlowsTraceDestination = {
  wallet: string;
  label: string;
  dest: string;
  received: number;
  t: string;
  status: "open" | "done" | "busy" | "budget" | "error" | "untracked";
  onward: WalletFlowsHop[];
  byKind: Record<string, number>;
  unaccounted: number;
};

export type WalletFlowsUnlabelledTrace = {
  window: string;
  totals: { received: number; byKind: Record<string, number> };
  destinations: WalletFlowsTraceDestination[];
};

export type WalletFlowsReport = {
  version: 1;
  generated: string;
  generator?: string;
  priceUsd: number;
  priceSource: string;
  chains: string[];
  notes: string[];
  distribution: {
    totalSupply: number;
    counted: number;
    source?: string;
    asOf?: string;
    classes: WalletFlowsDistributionClass[];
  };
  telcoinTotals: Record<FlowWindow, { total: number; usd: number; byVenue: Record<string, number>; note?: string }>;
  knownWallets: WalletFlowsKnownWallet[];
  fundingLinks: WalletFlowsFundingLink[];
  botCluster: {
    label: string;
    chain: string;
    note?: string;
    addresses: string[];
    balance: number;
    dexSales: Record<FlowWindow, number>;
    cexDeposits?: Record<FlowWindow, number>;
  };
  largeSellers: WalletFlowsSeller[];
  largeSellersWindow?: string;
  salesJournal?: WalletFlowsSalesJournal;
  unlabelledTrace?: WalletFlowsUnlabelledTrace;
};

const ADDRESS_EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io/address/",
  polygon: "https://polygonscan.com/address/",
  base: "https://basescan.org/address/",
};

/**
 * Address page on the chain's explorer. The project's configured explorer
 * (passed as `explorers`, key -> value) always wins: a value containing
 * `{address}` is a full template (Solana: "https://solscan.io/account/{address}",
 * base58 case kept), otherwise it is a root (`chains[].explorer`) and gets
 * `/address/<addr>`. Built-ins (TEL's chains) are only a fallback when the
 * project configures nothing for the chain; unknown chains fall back to Etherscan.
 */
export const addressExplorerUrl = (chain: string, address: string, explorers?: Record<string, string>) => {
  const configured = explorers?.[chain];
  if (configured?.includes("{address}")) return configured.split("{address}").join(address);
  const root = configured?.replace(/\/+$/, "");
  if (root) return `${root}/address/${address}`;
  const builtIn = ADDRESS_EXPLORER[chain];
  if (builtIn) return `${builtIn}${address}`;
  return `${ADDRESS_EXPLORER.ethereum}${address}`;
};
