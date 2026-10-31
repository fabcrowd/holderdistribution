import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Wraps any figure so clicking it pops a small bubble explaining what that
// specific number means — click, not hover, so touch users get the same
// affordance as mouse users (matches the tier-tile click convention already
// used elsewhere in this diagram). Styled as a dotted-underline inline button
// so it reads as interactive without adding visual weight to the numbers.
export const ExplainNumber = ({
  value,
  explanation,
  ariaLabel,
  className = "",
}: {
  value: ReactNode;
  explanation: string;
  ariaLabel?: string;
  className?: string;
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        onClick={(e) => e.stopPropagation()}
        aria-label={ariaLabel}
        className={`${className} underline decoration-dotted decoration-current/50 underline-offset-2 rounded-sm hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      >
        {value}
      </button>
    </PopoverTrigger>
    <PopoverContent className="w-64 text-xs leading-relaxed" onClick={(e) => e.stopPropagation()}>
      {explanation}
    </PopoverContent>
  </Popover>
);
