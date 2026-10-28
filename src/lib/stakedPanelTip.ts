/**
 * Holders dashboard "Staked" (i) copy.
 *
 * The sentence comes from the project's `holders.staked.info` (the same
 * string the Explore staked tile uses). Proof links are the staking
 * methodology links only when the project configured them — ZBCN's Solscan
 * program / lockup / vault ATAs, TEL's Polygonscan staking contracts.
 *
 * It must not branch on `stakingStats.v3`. Solana staking is published in
 * that slot, and a v3-shaped branch hardcodes the TEL Polygon StakingModule
 * sentence onto every token that reuses it.
 */
import { methodologyFor, type MethodologyLink } from "@/lib/methodology";
import { copyText } from "@/lib/projectCopy";
import type { ProjectConfig } from "@/lib/projects";

/** Same generic as the Explore staked tile when a project has no override. */
export const STAKED_INFO_FALLBACK =
  "{ticker} locked in staking, counted once per staker. It's a subset of Retail Held (already counted there), shown separately as a measure of long-term conviction. Staked {ticker} can't be sold until unstaked.";

export type StakedPanelTipModel = {
  body: string;
  links: MethodologyLink[];
};

type TipProject = Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "staking" | "copy">;

export const stakedPanelTip = (project: TipProject): StakedPanelTipModel => {
  const configured = project.copy?.methodology?.staking?.links ?? [];
  return {
    body: copyText(project, "holders.staked.info", STAKED_INFO_FALLBACK),
    links: configured.length > 0 ? methodologyFor(project, "staking").links : [],
  };
};
