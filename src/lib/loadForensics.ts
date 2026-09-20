import type { TelDispositionLedgerReport } from "@/components/TelDispositionLedger";
import type { FlowReport, WalletAnalysis } from "@/data/forensicsWriteups";
import { fetchForensicsGate, ForensicsGateError } from "@/lib/forensicsGateApi";

export type { WalletAnalysis, FlowReport };

export { ForensicsGateError };

const ASSOCIATION_FLOW_REPORT_KEY = "association-stablecoin-flows";
const TEL_DISPOSITION_LEDGER_KEY = "tel-disposition-ledger";

/** Load one wallet write-up after the password gate (or admin session) has opened. */
export const loadWalletAnalysis = async (
  address: string,
  password: string | null,
): Promise<WalletAnalysis | null> => {
  const { analysis } = await fetchForensicsGate(address, password);
  return (analysis as WalletAnalysis | null | undefined) ?? null;
};

/** Load the Association stablecoin outflow narrative. */
export const loadAssociationFlowReport = async (password: string | null): Promise<FlowReport> => {
  const { report } = await fetchForensicsGate(ASSOCIATION_FLOW_REPORT_KEY, password);
  if (!report) throw new ForensicsGateError("Missing flow report", 500);
  return report as FlowReport;
};

/** Load the treasury ledger — served only by the Netlify gate, not the static bundle. */
export const loadDispositionLedger = async (
  password: string | null,
): Promise<TelDispositionLedgerReport> => {
  const { report } = await fetchForensicsGate(TEL_DISPOSITION_LEDGER_KEY, password);
  if (!report) throw new ForensicsGateError("Missing disposition ledger", 500);
  return report as TelDispositionLedgerReport;
};
