import { useQuery } from "@tanstack/react-query";
import type { ClassificationChangelog } from "@/lib/classificationChangelog";

export type { ClassificationChangelog, ClassificationEvent } from "@/lib/classificationChangelog";
export { getEventsAffecting } from "@/lib/classificationChangelog";

const resolveUrl = () => {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}data/classification-changelog.json`;
};

/**
 * Fetches the classification changelog — the record of reclassification
 * events (see `config/classification-changelog.json`, `CLAUDE.md` →
 * "Reclassification changelog") used to stop delta chips and history charts
 * from reading as an artificial jump/drop when only categorization changed,
 * not real on-chain movement.
 */
export const useClassificationChangelog = () => {
  return useQuery({
    queryKey: ["classification-changelog"],
    queryFn: async (): Promise<ClassificationChangelog | null> => {
      const res = await fetch(resolveUrl());
      if (!res.ok) return null;
      return (await res.json()) as ClassificationChangelog;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
