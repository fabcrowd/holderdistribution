import { useMemo } from "react";
import { useProject } from "@/hooks/useProject";
import { getProject } from "@/lib/projects";
import {
  copyContext,
  copyText,
  fillCopy,
  hasCopyText,
  projectEntities,
  type CopyContext,
  type ProjectEntities,
} from "@/lib/projectCopy";
import { holderTiersFor, type HolderTiers } from "@/lib/holderTiers";
import { hasNoStaking } from "@/lib/stakingNote";

export type UseProjectCopy = CopyContext & {
  /** Fill a copy template ({ticker}, {name}, {chains}, {supply}) for the active project. */
  t: (template: string) => string;
  /** A widget string by id: the project's copy.text override, else `template`. Filled. */
  text: (id: string, template: string) => string;
  /** True when the project overrides widget string `id`. */
  hasText: (id: string) => boolean;
  /** Names of the project-controlled entities (foundation / team) on the Supply view. */
  entities: ProjectEntities;
  /** Holder-tier settings (balance ranges, distribution tiers, thresholds) — src/lib/holderTiers.ts. */
  tiers: HolderTiers;
  /** False for a token whose config lists no staking mechanism: copy must not mention staked balances. */
  hasStaking: boolean;
};

/** Build the copy helpers for one project (also used outside React, e.g. tests). */
export const projectCopyFor = (slug: string): UseProjectCopy => {
  const project = getProject(slug);
  const ctx = copyContext(project);
  return {
    ...ctx,
    t: (tpl: string) => fillCopy(tpl, ctx),
    text: (id: string, tpl: string) => copyText(project, id, tpl),
    hasText: (id: string) => hasCopyText(project, id),
    entities: projectEntities(project),
    tiers: holderTiersFor(project),
    hasStaking: !hasNoStaking(project),
  };
};

/** Active project's display copy: ticker, name, chain list, supply label + fillers. */
export const useProjectCopy = (): UseProjectCopy => {
  const { slug } = useProject();
  return useMemo(() => projectCopyFor(slug), [slug]);
};
