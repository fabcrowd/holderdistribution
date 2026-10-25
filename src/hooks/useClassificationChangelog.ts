import { useQuery } from "@tanstack/react-query";
import type { ClassificationChangelog } from "@/lib/classificationChangelog";
import { dataUrl } from "@/lib/dataUrl";
import { useProject } from "@/hooks/useProject";
import { FeedError } from "@/lib/fetchJson";

export type { ClassificationChangelog, ClassificationEvent } from "@/lib/classificationChangelog";
export { getEventsAffecting } from "@/lib/classificationChangelog";

const resolveUrl = (slug: string) => dataUrl(slug, "classification-changelog.json");

/**
 * Fetches the classification changelog — the record of reclassification
 * events (see `config/classification-changelog.json`, `CLAUDE.md` →
 * "Reclassification changelog") used to stop delta chips and history charts
 * from reading as an artificial jump/drop when only categorization changed,
 * not real on-chain movement.
 */
export const useClassificationChangelog = () => {
  const { slug } = useProject();
  return useQuery({
    queryKey: ["classification-changelog", slug],
    queryFn: async (): Promise<ClassificationChangelog | null> => {
      const res = await fetch(resolveUrl(slug));
      if (!res.ok) throw new FeedError(res.url || "feed", res.status);
      return (await res.json()) as ClassificationChangelog;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};
