import type { TelDispositionLedgerReport } from "@/components/TelDispositionLedger";
import type { FlowReport, WalletAnalysis } from "@/data/forensicsWriteups";
import { fetchForensicsGate, ForensicsGateError } from "@/lib/forensicsGateApi";
import type { WalletFlowsReport } from "@/lib/walletFlowsTypes";

export type { WalletAnalysis, FlowReport };

export { ForensicsGateError };

/**
 * Gated forensics loaders. Every loader takes the active project slug
 * (useProject().slug) and asks the gate for THAT project's payload; the gate
 * answers the same keys for every project and returns null when a project has
 * nothing gated yet (the panels then render an empty state). Omitting the slug
 * means the default project (TEL), as before multi-token.
 */
const ASSOCIATION_FLOW_REPORT_KEY = "association-stablecoin-flows";
/** Project-neutral ledger key (the gate also accepts the old "tel-disposition-ledger"). */
const DISPOSITION_LEDGER_KEY = "disposition-ledger";
export const WALLET_FLOWS_KEY = "wallet-flows";

/** Load one wallet write-up after the gate (password / admin session) has opened. */
export const loadWalletAnalysis = async (
  address: string,
  password: string | null,
  project?: string,
): Promise<WalletAnalysis | null> => {
  const { analysis } = await fetchForensicsGate(address, password, project);
  return (analysis as WalletAnalysis | null | undefined) ?? null;
};

/** Load the foundation stablecoin outflow narrative (null = none for this project). */
export const loadAssociationFlowReport = async (password: string | null, project?: string): Promise<FlowReport | null> => {
  const res = await fetchForensicsGate(ASSOCIATION_FLOW_REPORT_KEY, password, project);
  if (!("report" in res)) throw new ForensicsGateError("Missing flow report", 500);
  return (res.report as FlowReport | null) ?? null;
};

/** Load the treasury disposition ledger — gate only (null = none for this project). */
export const loadDispositionLedger = async (
  password: string | null,
  project?: string,
): Promise<TelDispositionLedgerReport | null> => {
  const res = await fetchForensicsGate(DISPOSITION_LEDGER_KEY, password, project);
  if (!("report" in res)) throw new ForensicsGateError("Missing disposition ledger", 500);
  return (res.report as TelDispositionLedgerReport | null) ?? null;
};

/** Load the Wallet flows report (supply by entity, linked wallets, large sellers). Gate only; null = none yet. */
export const loadWalletFlows = async (password: string | null, project?: string): Promise<WalletFlowsReport | null> => {
  const res = await fetchForensicsGate(WALLET_FLOWS_KEY, password, project);
  if (!("report" in res)) throw new ForensicsGateError("Missing wallet flows report", 500);
  return (res.report as WalletFlowsReport | null) ?? null;
};
