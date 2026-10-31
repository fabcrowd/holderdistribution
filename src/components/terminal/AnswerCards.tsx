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

const CARD = "flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3";

/** Three answer cards that replace the old KPI strip and headline sentence. */
export const AnswerCards = ({ tiles, selectedView, isError }: Props) => {
  const cards = pickAnswerTiles(tiles);
  if (cards.length === 0) {
    return (
      <div data-testid="answer-cards" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className={CARD}>
            {isError ? (
              i === 0 && <p className="text-sm text-muted-foreground">Headline numbers are unavailable right now.</p>
            ) : (
              <div aria-hidden="true" className="space-y-2">
                <div className="h-3 w-24 animate-pulse rounded bg-muted/70" />
                <div className="h-7 w-32 animate-pulse rounded bg-muted/70" />
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <dl data-testid="answer-cards" aria-label="Headline numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {cards.map((t) => (
        <div key={t.id} className={CARD} data-testid={`answer-${t.id}`}>
          <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t.label}
            {selectedView !== "combined" && t.scope === "all" && (
              <span className="rounded-sm bg-muted px-1 text-xs normal-case tracking-normal" title="Not split by chain: this figure covers all chains">
                All chains
              </span>
            )}
          </dt>
          <dd className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[28px] font-semibold leading-none tabular-nums text-brand">{t.value}</span>
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
          <p className={`flex items-center gap-1 text-xs ${t.ath ? "font-semibold text-ha-accent" : "text-muted-foreground"}`}>
            {t.sub}
            {t.ath && t.athNote && <InfoTip content={t.athNote} label={`All-time high: ${t.athNote}`} />}
          </p>
        </div>
      ))}
    </dl>
  );
};
