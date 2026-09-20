/**
 * Dev-only fallback when `vite` runs without `netlify dev` (no function endpoint).
 * Production always uses the Netlify gate.
 *
 * This module statically imports the forensic write-ups, so ANY production code
 * path that can reach it drags src/data/forensicsWriteups.ts into the bundle as
 * a publicly fetchable chunk. The only thing keeping it out is the
 * `import.meta.env.DEV` check in forensicsGateApi.ts's loadLocalPayload /
 * fallbackWithPassword — treat that guard as load-bearing, and re-verify by
 * grepping dist/assets after a build if this file gains a new caller.
 */
import type { TelDispositionLedgerReport } from "@/components/TelDispositionLedger";
import type { FlowReport, WalletAnalysis } from "@/data/forensicsWriteups";

const ASSOCIATION_FLOW_REPORT_KEY = "association-stablecoin-flows";

export const loadWalletAnalysisDev = async (address: string): Promise<WalletAnalysis | null> => {
  const { WALLET_ANALYSES } = await import("@/data/forensicsWriteups");
  return WALLET_ANALYSES[address.trim().toLowerCase()] ?? null;
};

export const loadAssociationFlowReportDev = async (): Promise<FlowReport> => {
  const { ASSOCIATION_STABLECOIN_FLOWS } = await import("@/data/forensicsWriteups");
  if (ASSOCIATION_STABLECOIN_FLOWS.key !== ASSOCIATION_FLOW_REPORT_KEY) {
    throw new Error("Unexpected flow report key");
  }
  return ASSOCIATION_STABLECOIN_FLOWS;
};

export const loadDispositionLedgerDev = async (): Promise<TelDispositionLedgerReport> => {
  const mod = await import("../../data/association-forensics/tel-disposition-ui.json");
  return (mod.default ?? mod) as TelDispositionLedgerReport;
};
