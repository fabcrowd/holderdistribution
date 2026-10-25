import { useHeadlineSummary } from "@/hooks/useHeadlineSummary";
import { DataFreshnessBadge, StaleDataBanner } from "@/components/DataFreshness";
import { HeadlineBody } from "@/components/HeadlineBody";
import { TokenSwitcher } from "@/components/TokenSwitcher";

/**
 * First-screen answer to "what is happening with TEL holders?": a real page
 * heading, one plain sentence built from the headline numbers, up to three
 * trend bullets and the data's age. Everything here derives from the same
 * useEcosystemHeadlineTiles values the KPI tiles render, so it cannot drift.
 */
export const PageIntro = ({ rangeDays }: { rangeDays: number }) => {
  const { summary, snapshot, isError } = useHeadlineSummary(rangeDays);

  return (
    <section aria-labelledby="page-title" className="mb-5 sm:mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 id="page-title" className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
          <TokenSwitcher variant="heading" /> holder distribution
        </h1>
        <DataFreshnessBadge generatedAt={snapshot?.generatedAt} />
      </div>
      {summary ? (
        <HeadlineBody summary={summary} />
      ) : isError ? (
        <p className="max-w-3xl text-sm text-muted-foreground">
          Headline numbers are unavailable right now. The panels below explain what failed and let you retry.
        </p>
      ) : (
        <div className="max-w-3xl space-y-2" aria-hidden="true">
          <div className="h-6 w-full max-w-xl rounded-md bg-muted/70 animate-pulse" />
          <div className="h-4 w-2/3 max-w-md rounded-md bg-muted/60 animate-pulse" />
        </div>
      )}
      <StaleDataBanner generatedAt={snapshot?.generatedAt} />
    </section>
  );
};

export default PageIntro;
