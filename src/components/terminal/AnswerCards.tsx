import { ChangeIndicator } from "@/components/ChangeIndicator";
import { InfoTip } from "@/components/InfoTip";
import type { EcosystemHeadlineTile } from "@/hooks/useEcosystemHeadlineTiles";
import type { DisplaySelection } from "@/hooks/useHolderSnapshot";
import { pickAnswerTiles } from "@/lib/answerCards";

type Props = {
  tiles: readonly EcosystemHeadlineTile[];
  selectedView: DisplaySelection;
  isError: boolean;
};

/** One strip for the three answer figures: stacked rows on phones, three columns from sm up. */
const STRIP = "grid grid-cols-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0";
const CELL =
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 sm:flex sm:flex-col sm:items-start sm:gap-1 sm:py-3";
const LABEL = "col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-muted-foreground";
const VALUE =
  "col-start-2 row-span-2 row-start-1 flex shrink-0 flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 sm:justify-start";

/** Three answer figures in one strip that replaces the old KPI strip and headline sentence. */
export const AnswerCards = ({ tiles, selectedView, isError }: Props) => {
  const cards = pickAnswerTiles(tiles);
  if (cards.length === 0 && isError) {
    return (
      <div data-testid="answer-cards" className="rounded-lg border border-border bg-card">
        <p className="px-4 py-3 text-sm text-muted-foreground">Headline numbers are unavailable right now.</p>
      </div>
    );
  }
  if (cards.length === 0) {
    return (
      <div data-testid="answer-cards" className={STRIP}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={CELL}>
            <div aria-hidden="true" className="space-y-2">
              <div className="h-3 w-24 animate-pulse rounded bg-muted/70" />
              <div className="h-7 w-32 animate-pulse rounded bg-muted/70" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <dl data-testid="answer-cards" aria-label="Headline numbers" className={STRIP}>
      {cards.map((t) => (
        <div key={t.id} className={CELL} data-testid={`answer-${t.id}`}>
          {/* Phones: label left, value right, sub under the label. From sm up the
              cell is a column in DOM order: label, value, sub. */}
          <dt className={LABEL}>
            {t.label}
            {selectedView !== "combined" && t.scope === "all" && (
              <span className="rounded-sm bg-muted px-1 text-xs normal-case tracking-normal" title="Not split by chain: this figure covers all chains">
                All chains
              </span>
            )}
          </dt>
          <dd data-role="value" className={VALUE}>
            <span className="ha-num text-[22px] font-medium leading-none text-foreground sm:text-[26px]">{t.value}</span>
            {t.current !== null && (
              <ChangeIndicator
                variant="plain"
                current={t.current}
                previous={t.previous}
                formatter={t.fmt}
                tone={t.tone ?? "auto"}
                changelogEvents={t.changelogEvents}
              />
            )}
          </dd>
          <dd
            data-role="sub"
            className={`col-start-1 row-start-2 flex min-w-0 items-center gap-1 text-xs ${t.ath ? "font-semibold text-ha-accent" : "text-muted-foreground"}`}
          >
            <span className="min-w-0 truncate sm:whitespace-normal">{t.sub}</span>
            {t.ath && t.athNote && <InfoTip content={t.athNote} label={`All-time high: ${t.athNote}`} />}
          </dd>
        </div>
      ))}
    </dl>
  );
};
