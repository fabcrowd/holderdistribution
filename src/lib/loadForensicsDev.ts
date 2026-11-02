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
import type { WalletFlowsReport } from "@/lib/walletFlowsTypes";

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

export const loadWalletFlowsDev = async (): Promise<WalletFlowsReport> => {
  const mod = await import("../../data/forensics/wallet-flows.json");
  return (mod.default ?? mod) as unknown as WalletFlowsReport;
};

/**
 * Other projects' reports (e.g. Solana ZBCN) from the local, uncommitted
 * `data/<slug>/forensics/wallet-flows.json`, so the panel can be checked in dev
 * before the file is committed. `null` when the project has no local report.
 * Same DEV-only guard as the rest of this module (see the header).
 */
const PROJECT_WALLET_FLOWS = import.meta.glob("../../data/*/forensics/wallet-flows.json");

export const loadProjectWalletFlowsDev = async (slug: string): Promise<WalletFlowsReport | null> => {
  const load = PROJECT_WALLET_FLOWS[`../../data/${slug}/forensics/wallet-flows.json`];
  if (!load) return null;
  const mod = (await load()) as { default?: unknown };
  return (mod.default ?? mod) as unknown as WalletFlowsReport;
};
