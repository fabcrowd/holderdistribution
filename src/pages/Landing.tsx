import { useQueries } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { TokenCard } from "@/components/TokenCard";
import { usePageMeta } from "@/hooks/usePageMeta";
import { fetchHolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { fetchHolderHistoryPayload } from "@/hooks/useHoldersHistoryData";
import { fetchClassificationChangelog } from "@/hooks/useClassificationChangelog";
import { TREND_DAYS, afterBreakNote, cardConcentration, cardTrendState } from "@/lib/cardTrend";
import { getSeriesBreaks } from "@/lib/seriesBreaks";
import { PROJECTS, getProject } from "@/lib/projects";
import { cardStats } from "@/lib/landingStats";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/seo";

/**
 * Home: pick a token, then open its terminal. One card per mapped project; the
 * stats come from each token's existing holders-lite.json under the same query
 * key the terminal uses (["holder-lite", slug]), so opening a card reuses the
 * cached snapshot. Concentration (top-10/top-100 share) comes from the same
 * snapshot; the 30-day sparkline from holders-history.json (key
 * ["holders-history", slug], shared with the terminal). Each query fails on its
 * own: stats show "—" and the sparkline a placeholder.
 */
const Landing = () => {
  usePageMeta({ title: SITE_TITLE, description: SITE_DESCRIPTION, canonicalPath: "/" });

  const queries = useQueries({
    queries: PROJECTS.map((p) => ({
      queryKey: ["holder-lite", p.slug],
      queryFn: () => fetchHolderLiteSnapshot(p.slug),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  const histories = useQueries({
    queries: PROJECTS.map((p) => ({
      queryKey: ["holders-history", p.slug],
      queryFn: () => fetchHolderHistoryPayload(p.slug),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  const changelogs = useQueries({
    queries: PROJECTS.map((p) => ({
      queryKey: ["classification-changelog", p.slug],
      queryFn: () => fetchClassificationChangelog(p.slug),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  return (
    <div className="flex min-h-[100svh] flex-col bg-background">
      <Navigation />
      <main id="main-content" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:py-12">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">Token holder distribution</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          On-chain holder counts, distribution and supply for each mapped token. Pick a token to open its terminal.
        </p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Tokens">
          {PROJECTS.map((p, i) => {
            const q = queries[i];
            const project = getProject(p.slug);
            const stats = q.isPending ? null : cardStats(q.isError ? null : q.data);
            const h = histories[i];
            const snap = q.isError ? null : q.data;
            // from=0 returns every break; cardTrend keeps only those inside its window.
            const breaks = getSeriesBreaks(changelogs[i]?.data, ["retail.count", "holderCount"], 0).map((b) => b.t);
            const trendState = h.isPending || h.isError ? null : cardTrendState(h.data?.entries, TREND_DAYS, breaks);
            return (
              <li key={p.slug}>
                <TokenCard
                  slug={p.slug}
                  name={project.name}
                  ticker={project.ticker}
                  image={project.image}
                  stats={stats}
                  concentration={q.isPending ? null : cardConcentration(snap)}
                  trendLoading={h.isPending}
                  trend={trendState?.trend ?? null}
                  trendNote={trendState?.reason === "after-break" ? afterBreakNote(trendState.sinceBreak) : undefined}
                />
              </li>
            );
          })}
        </ul>
      </main>
      <Footer />
    </div>
  );
};

export default Landing;
