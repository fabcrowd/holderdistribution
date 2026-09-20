// Deprecated: Supply forensics load from the client (src/lib/loadForensics.ts).
// This module remains only so an old Edge Function deploy does not break at import time.

export {
  ASSOCIATION_FLOW_REPORT_KEY,
  ASSOCIATION_STABLECOIN_FLOWS,
  WALLET_ANALYSES,
  type FlowReport,
  type FlowReportSection,
  type WalletAnalysis,
} from "../../../src/data/forensicsWriteups.ts";

export { TEL_DISPOSITION_LEDGER } from "./tel-disposition.generated.ts";

export const TEL_DISPOSITION_LEDGER_KEY = "tel-disposition-ledger";
