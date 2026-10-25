import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { SummaryPoint, HolderSummary } from "@/lib/holderSummary";

const TREND_STYLE: Record<SummaryPoint["trend"], { Icon: typeof Minus; cls: string }> = {
  up: { Icon: ArrowUpRight, cls: "text-emerald-700 dark:text-emerald-400" },
  down: { Icon: ArrowDownRight, cls: "text-red-700 dark:text-red-400" },
  flat: { Icon: Minus, cls: "text-muted-foreground" },
  unknown: { Icon: Minus, cls: "text-muted-foreground" },
};

/**
 * The plain-language headline (one sentence + trend bullets) shared by the
 * mobile page intro and the desktop terminal strip. Both read the same
 * `buildHolderSummary` output, so the words can't drift.
 */
export const HeadlineBody = ({ summary, dense = false }: { summary: HolderSummary; dense?: boolean }) => (
  <div className={dense ? "min-w-0 space-y-0.5" : "max-w-3xl space-y-2"} data-testid={dense ? undefined : "page-summary"}>
    <p className={dense ? "text-sm leading-snug text-foreground/90" : "text-base sm:text-lg leading-snug text-foreground/90"}>
      {summary.headline}
    </p>
    {summary.points.length > 0 && (
      <ul
        className={
          dense
            ? "flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground"
            : "flex flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-5"
        }
      >
        {summary.points.map((p) => {
          const { Icon, cls } = TREND_STYLE[p.trend];
          return (
            <li key={p.id} className="inline-flex items-start gap-1.5">
              <Icon aria-hidden="true" className={`mt-0.5 shrink-0 ${dense ? "h-3.5 w-3.5" : "h-4 w-4"} ${cls}`} />
              <span>{p.text}</span>
            </li>
          );
        })}
      </ul>
    )}
  </div>
);
