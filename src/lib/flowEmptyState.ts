/**
 * Empty-state copy for the exchange and tier flow panels.
 *
 * Only called from a panel's empty branch (no flow rows to show). A Solana
 * project has no EVM transfer scan, so its flows are "not tracked yet" rather
 * than "no data for this period". EVM and unknown projects keep the panels'
 * existing wording, and a placeholder feed keeps its unavailable copy.
 */
import { resolveChainVm } from "@/lib/explorerLinks";
import { TIER_OUTFLOWS_FEED, EXCHANGE_FLOW_FEED, flowUnavailableText, isFlowPlaceholder } from "@/lib/flowFeeds";
import type { ProjectConfig } from "@/lib/projects";

export type FlowEmptyKind = "exchange" | "tier";

export const SOLANA_FLOWS_UNTRACKED = "Solana flows not tracked yet";

const EXISTING_EMPTY_TEXT: Record<FlowEmptyKind, string> = {
  exchange: "No flow data for this period.",
  tier: "No tier flows for this period yet.",
};

const FEED_BY_KIND: Record<FlowEmptyKind, string> = {
  exchange: EXCHANGE_FLOW_FEED,
  tier: TIER_OUTFLOWS_FEED,
};

const hasSolanaChain = (project: Pick<ProjectConfig, "chains">): boolean =>
  (project.chains ?? []).some((c) => resolveChainVm(c) === "solana");

export const flowEmptyMessage = (
  project: Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy" | "health">,
  kind: FlowEmptyKind,
): string => {
  // A Solana project with a real flow feed (e.g. ZBCN) is tracked; an empty window there is plain "no data".
  if (!isFlowPlaceholder(project, FEED_BY_KIND[kind])) return EXISTING_EMPTY_TEXT[kind];
  return hasSolanaChain(project) ? SOLANA_FLOWS_UNTRACKED : flowUnavailableText(project);
};
