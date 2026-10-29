/**
 * Holders dashboard "{ticker} held" (i) copy.
 *
 * The sentence is the project's `holders.held.info`. A generic fallback only
 * describes retail vs exchange custody. Whether staked tokens sit inside
 * retail is a project fact (TEL: yes, including the v3 StakingModule; ZBCN:
 * not yet) and lives in that override — this module does not branch on
 * `stakingStats.v3`, which Solana staking also occupies.
 *
 * `{stakedTotal}` and `{stakedV3}` are filled from the live snapshot when the
 * project's copy asks for them. A sentence that needs `{stakedV3}` is omitted
 * until that figure exists, so a loading panel doesn't invent a zero balance.
 */
import { formatCompact } from "@/lib/format";
import { copyContext, fillCopy } from "@/lib/projectCopy";
import type { ProjectConfig } from "@/lib/projects";

export const HELD_INFO_FALLBACK =
  "{ticker} in retail wallets compared with {ticker} in custody at known exchange wallets. All chains combined.";

export type HeldPanelFigures = {
  stakedTotal?: number | null;
  stakedV3?: number | null;
};

type TipProject = Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy">;

const withoutUnmeasuredV3 = (template: string, figures: HeldPanelFigures): string => {
  if (figures.stakedV3 != null || !template.includes("{stakedV3}")) return template;
  return template
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !sentence.includes("{stakedV3}"))
    .join(" ");
};

const fillFigure = (template: string, key: string, value: number | null | undefined): string =>
  template.split(`{${key}}`).join(value != null ? formatCompact(value) : "—");

export const heldPanelTip = (project: TipProject, figures: HeldPanelFigures = {}): string => {
  const template = withoutUnmeasuredV3(project.copy?.text?.["holders.held.info"] ?? HELD_INFO_FALLBACK, figures);
  const filled = fillCopy(template, copyContext(project));
  return fillFigure(fillFigure(filled, "stakedTotal", figures.stakedTotal), "stakedV3", figures.stakedV3);
};
