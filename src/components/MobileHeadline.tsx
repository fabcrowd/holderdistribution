import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { AnswerCards } from "@/components/terminal/AnswerCards";
import { useHeadlineSummary } from "@/hooks/useHeadlineSummary";
import type { DisplaySelection } from "@/hooks/useHolderSnapshot";
import { ANSWER_CARD_IDS } from "@/lib/answerCards";

type Props = { rangeDays: number; selectedView: DisplaySelection };

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
                  <div key={t.id} className="flex flex-col gap-1">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.label}</dt>
                    <dd className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-2xl font-semibold tabular-nums text-brand">{t.value}</span>
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
                    <p className="text-xs text-muted-foreground">{t.sub}</p>
                  </div>
                ))}
              </dl>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </section>
  );
};
