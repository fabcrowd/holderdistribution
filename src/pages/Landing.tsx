import { useQueries } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { TokenCard } from "@/components/TokenCard";
import { ComingSoonCard } from "@/components/ComingSoonCard";
import { usePageMeta } from "@/hooks/usePageMeta";
import { fetchHolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { fetchHolderHistoryPayload } from "@/hooks/useHoldersHistoryData";
import { fetchClassificationChangelog } from "@/hooks/useClassificationChangelog";
import { TREND_DAYS, afterBreakNote, cardConcentration, cardTrendState } from "@/lib/cardTrend";
import { getSeriesBreaks } from "@/lib/seriesBreaks";
import { PROJECTS, getProject } from "@/lib/projects";
import { cardStats } from "@/lib/landingStats";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/seo";

const HERO_POINTS = [
  {
    title: "Facts over narrative",
    body: "We report what the chain shows: who holds each token, how balances move, and where the supply sits.",
  },
  {
    title: "Open methods",
    body: "The data is public and the methodology is published in the app, so you can see how each number is produced.",
  },
  {
    title: "Built for everyday holders",
    body: "Blockchain should be readable without a developer or a block explorer. We make it that way.",
  },
] as const;

/** Tokens announced but not mapped yet; shown as placeholders after the live cards. */
const COMING_SOON = [
  { name: "Cronos", ticker: "CRO", image: "/tokens/cro.png" },
  { name: "Ondo", ticker: "ONDO", image: "/tokens/ondo.png" },
  { name: "Monad", ticker: "MON", image: "/tokens/mon.png" },
  { name: "Plasma", ticker: "XPL", image: "/tokens/xpl.png" },
] as const;

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
      <main id="main-content" className="w-full flex-1">
        <section aria-labelledby="hero-title" className="border-b border-border bg-card">
          <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-10 sm:py-14 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Blockchain without the BS.</p>
              <h1 id="hero-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-foreground sm:text-4xl">
                Who holds each token, and how that&apos;s changing.
              </h1>
              <p className="mt-4 max-w-xl text-base text-muted-foreground">
                Crypto projects are full of hype, influencer takes and whitepaper promises. Holder Distribution exists to
                filter out the narratives and give people a trusted resource where they can learn what the blockchain data
                really says about a project.
              </p>
            </div>
            <ol className="divide-y divide-border border-y border-border" aria-label="What you will find">
              {HERO_POINTS.map((point, i) => (
                <li key={point.title} className="flex gap-4 py-4">
                  <span className="font-mono text-sm font-semibold text-primary">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <p className="font-semibold text-foreground">{point.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{point.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>
        <section aria-labelledby="tokens-title" className="mx-auto w-full max-w-7xl px-4 py-8 sm:py-12">
          <h2 id="tokens-title" className="scroll-mt-20 text-xl font-bold tracking-tight text-foreground">Tokens</h2>
          <p className="mt-1 text-sm text-muted-foreground">Pick a token to open its terminal.</p>
        <ul className="mt-6 grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Tokens">
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
          {COMING_SOON.map((token) => (
            <li key={token.ticker}>
              <ComingSoonCard name={token.name} ticker={token.ticker} image={token.image} />
            </li>
          ))}
        </ul>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default Landing;
