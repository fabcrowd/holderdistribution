import { ExternalLink } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { InfoTip } from "@/components/InfoTip";
import { AnswerCards } from "@/components/terminal/AnswerCards";
import { useHeadlineSummary } from "@/hooks/useHeadlineSummary";
import type { DisplaySelection } from "@/hooks/useHolderSnapshot";
import type { EcosystemHeadlineTile } from "@/hooks/useEcosystemHeadlineTiles";
import { ANSWER_CARD_IDS } from "@/lib/answerCards";
import type { MethodologyLink } from "@/lib/methodology";

type Props = { rangeDays: number; selectedView: DisplaySelection };

/** Tooltip body for a headline tile: one sentence plus the proof links, nothing longer. */
const TileInfo = ({ text, links }: { text?: string | null; links: MethodologyLink[] }) => (
  <div className="space-y-2">
    {text && <p>{text}</p>}
    {links.length > 0 && (
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/50 pt-2">
        {links.map((link) => (
          <a
            key={`${link.label}:${link.href}`}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            {link.label} <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ))}
      </div>
    )}
  </div>
);

const DetailTile = ({ tile, selectedView }: { tile: EcosystemHeadlineTile; selectedView: DisplaySelection }) => (
  <div className="flex flex-col gap-1">
    <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {tile.label}
      {selectedView !== "combined" && tile.scope === "all" && (
        <span className="rounded-sm bg-muted px-1 normal-case tracking-normal" title="Not split by chain: this figure covers all chains">
          All chains
        </span>
      )}
      {(tile.infoTooltip || (tile.infoLinks?.length ?? 0) > 0) && (
        <InfoTip label={`About ${tile.label}`} content={<TileInfo text={tile.infoTooltip} links={tile.infoLinks ?? []} />} />
      )}
    </dt>
    <dd className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-2xl font-semibold tabular-nums text-brand">{tile.value}</span>
      {tile.current !== null && (
        <ChangeIndicator
          variant="plain"
          current={tile.current}
          previous={tile.previous}
          formatter={tile.fmt}
          tone={tile.tone ?? "auto"}
          changelogEvents={tile.changelogEvents}
        />
      )}
    </dd>
    <p className="text-xs text-muted-foreground">{tile.sub}</p>
  </div>
);

/**
 * Below 1280px: the same three answer cards as the desktop shell, with the
 * remaining tiles (staked, for projects that have it) behind a Details
 * accordion. Wallet sizes and exchange balances are panels of the stacked
 * layout already, so they are not repeated here.
 */
export const MobileHeadline = ({ rangeDays, selectedView }: Props) => {
  const { tiles, isError } = useHeadlineSummary(rangeDays, selectedView);
  const extra = tiles.filter((t) => !ANSWER_CARD_IDS.includes(t.id));
  return (
    <section aria-label="Headline numbers" data-testid="mobile-headline" className="mb-5 space-y-3">
      <AnswerCards tiles={tiles} selectedView={selectedView} isError={isError} />
      {extra.length > 0 && (
        <Accordion type="single" collapsible data-testid="mobile-details">
          <AccordionItem value="details" className="rounded-lg border border-border bg-card px-4">
            <AccordionTrigger className="min-h-[44px] py-3 text-sm font-semibold">
              Details: {extra.map((t) => t.label).join(", ")}
            </AccordionTrigger>
            <AccordionContent>
              <dl className="space-y-3">
                {extra.map((t) => (
                  <DetailTile key={t.id} tile={t} selectedView={selectedView} />
                ))}
              </dl>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </section>
  );
};
