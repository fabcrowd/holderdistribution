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
};

const ADDRESS_EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io/address/",
  polygon: "https://polygonscan.com/address/",
  base: "https://basescan.org/address/",
};

export const addressExplorerUrl = (chain: string, address: string) =>
  `${ADDRESS_EXPLORER[chain] ?? ADDRESS_EXPLORER.ethereum}${address}`;
