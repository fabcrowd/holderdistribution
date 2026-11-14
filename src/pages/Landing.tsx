import type { ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
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
import { LISTED_PROJECTS, getProject } from "@/lib/projects";
import { comingSoonTokens } from "@/lib/comingSoon";
import { DASH, boardTotals, cardStats } from "@/lib/landingStats";
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

const COMING_SOON = comingSoonTokens(LISTED_PROJECTS);

const CTA_CLASS =
  "inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const CoverageStat = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="px-0 py-4 sm:px-5 sm:first:pl-0">
    <dt className="text-[13px] text-muted-foreground">{label}</dt>
    <dd className="ha-num mt-1 text-2xl font-medium text-foreground sm:text-[28px]">{children}</dd>
  </div>
);

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
    queries: LISTED_PROJECTS.map((p) => ({
      queryKey: ["holder-lite", p.slug],
      queryFn: () => fetchHolderLiteSnapshot(p.slug),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  const histories = useQueries({
    queries: LISTED_PROJECTS.map((p) => ({
      queryKey: ["holders-history", p.slug],
      queryFn: () => fetchHolderHistoryPayload(p.slug),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  const changelogs = useQueries({
    queries: LISTED_PROJECTS.map((p) => ({
      queryKey: ["classification-changelog", p.slug],
      queryFn: () => fetchClassificationChangelog(p.slug),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  const totals = boardTotals(
    queries.map((q) => (q.isError ? null : q.data)),
    LISTED_PROJECTS.map((p) => getProject(p.slug).chains.map((c) => c.key)),
  );
  const walletsPending = totals.wallets === DASH && queries.some((q) => q.isPending);

  return (
    <div className="flex min-h-[100svh] flex-col bg-background">
      <Navigation />
      <main id="main-content" className="w-full flex-1">
        <section aria-labelledby="hero-title" className="ha-grid-bg border-b border-border">
          <div className="mx-auto w-full max-w-7xl px-4 pt-10 pb-8 sm:pt-14 sm:pb-10">
            <p className="ha-eyebrow">Blockchain without the BS.</p>
            <h1 id="hero-title" className="ha-display mt-3 max-w-4xl text-[clamp(2.125rem,5.4vw,4.25rem)] leading-[1.03] text-foreground">
              Who holds each token, and how that&apos;s changing.
            </h1>
            <p className="mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
              Crypto projects are full of hype, influencer takes and whitepaper promises. Holder Distribution exists to
              filter out the narratives and give people a trusted resource where they can learn what the blockchain data
              really says about a project.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a href="#tokens" className={CTA_CLASS}>
                Browse tokens
                <ArrowDown aria-hidden="true" className="h-4 w-4" />
              </a>
              <a
                href="#why-title"
                className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:border-border-strong hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Why this exists
              </a>
            </div>
            <dl aria-label="Coverage" className="mt-10 grid grid-cols-2 divide-border border-y border-border sm:grid-cols-4 sm:divide-x">
              <CoverageStat label="Tokens tracked">{totals.tokens}</CoverageStat>
              <CoverageStat label="Retail wallets across tokens">
                {walletsPending ? (
                  <div aria-label="Loading" className="h-7 w-28 animate-pulse rounded bg-muted/70" />
                ) : (
                  totals.wallets
                )}
              </CoverageStat>
              <CoverageStat label="Chains covered">{totals.chains}</CoverageStat>
              <div className="px-0 py-4 sm:px-5 sm:first:pl-0">
                <dt className="text-[13px] text-muted-foreground">Refreshed</dt>
                <dd className="mt-1 flex items-baseline gap-2">
                  <span className="font-display text-2xl font-bold text-foreground sm:text-[28px]">Daily</span>
                  <span className="ha-num text-[13px] text-muted-foreground">06:00 UTC</span>
                </dd>
              </div>
            </dl>
          </div>
        </section>
        <section id="tokens" aria-labelledby="tokens-title" className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 py-8 sm:py-10">
          <div className="flex items-center gap-2">
            <h2 id="tokens-title" className="font-display text-xl font-bold tracking-tight text-foreground">Tokens</h2>
            <span className="ha-num rounded-pill border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {LISTED_PROJECTS.length}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Pick a token to open its terminal.</p>
          <ul className="mt-6 grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Tokens">
            {LISTED_PROJECTS.map((p, i) => {
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
          {COMING_SOON.length > 0 && (
            <div className="mt-8">
              <h3 className="text-sm font-semibold text-muted-foreground">Coming soon</h3>
              <ul aria-label="Coming soon" className="mt-3 flex flex-wrap gap-3">
                {COMING_SOON.map((token) => (
                  <li key={token.ticker}>
                    <ComingSoonCard name={token.name} ticker={token.ticker} image={token.image} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section aria-labelledby="why-title" className="border-t border-border bg-card">
          <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:py-14">
            <h2 id="why-title" className="scroll-mt-20 font-display text-xl font-bold tracking-tight text-foreground">Why this exists</h2>
            <ol className="mt-6 grid gap-6 md:grid-cols-3 md:gap-8" aria-label="What you will find">
              {HERO_POINTS.map((point, i) => (
                <li key={point.title} className="border-t-2 border-primary/50 pt-4">
                  <span className="ha-num text-sm font-medium text-primary">{String(i + 1).padStart(2, "0")}</span>
                  <p className="mt-2 font-semibold text-foreground">{point.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{point.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default Landing;
