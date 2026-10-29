import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type TapTileProps = {
  /** Short label, e.g. "Net change". Long wording belongs in `explanation`. */
  label: ReactNode;
  /** Headline number(s). */
  value: ReactNode;
  /** Explanation shown in a popover when the tile is tapped or focused. */
  explanation: ReactNode;
  testId?: string;
};

/**
 * Phone metric tile: a label and a headline value. Tapping it opens the
 * explanation in a Popover, which dismisses on an outside tap or Escape. This
 * keeps the on-screen text to the numbers themselves on a 390px screen.
 */
export const TapTile = ({ label, value, explanation, testId }: TapTileProps) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        data-testid={testId}
        className="premium-surface-card flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="shrink-0 text-right text-sm font-bold tabular-nums text-foreground">{value}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent className="w-64 whitespace-pre-line text-xs leading-relaxed" onClick={(e) => e.stopPropagation()}>
      {explanation}
    </PopoverContent>
  </Popover>
);
