import { useSyncExternalStore } from "react";
import { PROJECTS, getProject, type ProjectConfig, type ProjectEntry } from "@/lib/projects";
import { getActiveSlug, setActiveSlug, subscribeActiveSlug } from "@/lib/projectStore";

export type UseProject = {
  /** Active project slug, e.g. "tel". Use it in feed URLs and query keys. */
  slug: string;
  project: ProjectConfig;
  projects: readonly ProjectEntry[];
  setProject: (slug: string) => void;
};

/** Active project for every view (Holders / Distribution / Supply). */
export const useProject = (): UseProject => {
  const slug = useSyncExternalStore(subscribeActiveSlug, getActiveSlug, getActiveSlug);
  return { slug, project: getProject(slug), projects: PROJECTS, setProject: setActiveSlug };
};
