import { resolveChainVm, type ChainVm } from "@/lib/explorerLinks";

type VmChain = { key: string; vm?: ChainVm };

/**
 * True when every chain of the project is scanned by venue (exchange accounts), not by
 * wallet-to-wallet transfers. Mirrors scripts/generate-tier-outflows.js: Solana and Hedera
 * projects with no EVM chain build their flow days from exchange-account transactions, so
 * counterparty-tier attribution is never measured for them.
 */
export const isVenueScannedFlows = (chains: readonly VmChain[] | undefined): boolean =>
  !!chains && chains.length > 0 && chains.every((c) => resolveChainVm(c) !== "evm");
