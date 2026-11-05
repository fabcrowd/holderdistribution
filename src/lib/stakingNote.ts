/**
 * Note for a token that has no staking mechanism. Discovery decides staking per token
 * (config `staking[]`: none, a StakeChanged contract, a receipt module, a program on
 * another VM), so an empty `staking[]` is a finding, not missing data: the Staked tile is
 * omitted and the Staked panel says why instead of "No data for this period".
 */
import { COMBINED_VIEW, stakedScope } from "@/lib/chainViews";
import { copyText } from "@/lib/projectCopy";
import type { ProjectConfig } from "@/lib/projects";

export const STAKING_NONE_ID = "staking.none";
export const STAKING_NONE_TEMPLATE = "{name} has no staking contract or staking mechanism, so there is no staked supply to show.";

/** True when no chain of the project holds a staking entry. */
export const hasNoStaking = (project: Pick<ProjectConfig, "chains" | "staking">): boolean =>
  stakedScope(project, COMBINED_VIEW).kind === "none";

/** Panel copy for a token without staking; a project can override via copy.text["staking.none"]. */
export const stakingNoneText = (
  project: Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy">,
): string => copyText(project, STAKING_NONE_ID, STAKING_NONE_TEMPLATE);
