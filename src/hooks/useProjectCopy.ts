import { useMemo } from "react";
import { useProject } from "@/hooks/useProject";
import { getProject } from "@/lib/projects";
import { copyContext, copyText, fillCopy, type CopyContext } from "@/lib/projectCopy";

export type UseProjectCopy = CopyContext & {
  /** Fill a copy template ({ticker}, {name}, {chains}, {supply}) for the active project. */
  t: (template: string) => string;
  /** A widget string by id: the project's copy.text override, else `template`. Filled. */
  text: (id: string, template: string) => string;
};

/** Build the copy helpers for one project (also used outside React, e.g. tests). */
export const projectCopyFor = (slug: string): UseProjectCopy => {
  const project = getProject(slug);
  const ctx = copyContext(project);
  return {
    ...ctx,
    t: (tpl: string) => fillCopy(tpl, ctx),
    text: (id: string, tpl: string) => copyText(project, id, tpl),
  };
};

/** Active project's display copy: ticker, name, chain list, supply label + fillers. */
export const useProjectCopy = (): UseProjectCopy => {
  const { slug } = useProject();
  return useMemo(() => projectCopyFor(slug), [slug]);
};
