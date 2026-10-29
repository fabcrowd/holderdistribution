import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CLOSED_TOOLTIP_STATE, reduceTooltipState, type TooltipEvent } from "@/components/ui/stat-tile-state";

/** Pause before a mouse-hover explainer closes, so the pointer can cross into it. */
const HOVER_CLOSE_DELAY_MS = 120;

export type StatTileProps = {
  label: ReactNode;
  value: ReactNode;
  /** Short line under the value, e.g. "over 301 days". */
  sub?: ReactNode;
  /** Text colour class for the value (tone). */
  valueClassName?: string;
  /** One or two sentences explaining the number. Shown on tap, click, hover or focus. */
  info: string;
  className?: string;
};

/**
 * A stat tile whose explainer opens on tap or click (pinned until the next
 * tap, an outside tap or Escape), on mouse hover, and on keyboard focus.
 * The whole tile is one focusable button, so touch, mouse and keyboard all
 * work. Reuse it anywhere a metric needs its meaning on demand.
 */
export const StatTile = ({ label, value, sub, valueClassName, info, className }: StatTileProps) => {
  const [state, setState] = useState(CLOSED_TOOLTIP_STATE);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const infoId = useId();

  const send = (event: TooltipEvent) => setState((prev) => reduceTooltipState(prev, event));
  const cancelScheduledClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleHoverClose = () => {
    cancelScheduledClose();
    closeTimer.current = window.setTimeout(() => send({ type: "hoverOut" }), HOVER_CLOSE_DELAY_MS);
  };
  useEffect(() => cancelScheduledClose, []);

  const mouseOnly = (handler: () => void) => (e: { pointerType: string }) => {
    if (e.pointerType === "mouse") handler();
  };

  return (
    <Popover open={state.open} onOpenChange={(next) => { if (!next) send({ type: "dismiss" }); }}>
      <PopoverAnchor asChild>
        <div ref={wrapperRef} className="relative h-full min-w-0">
          <button
            type="button"
            aria-describedby={infoId}
            onClick={() => {
              cancelScheduledClose();
              send({ type: "tap" });
            }}
            onFocus={() => send({ type: "focus" })}
            onBlur={() => send({ type: "blur" })}
            onPointerEnter={mouseOnly(() => {
              cancelScheduledClose();
              send({ type: "hoverIn" });
            })}
            onPointerLeave={mouseOnly(scheduleHoverClose)}
            className={cn(
              "premium-surface-card flex h-full w-full min-w-0 flex-col items-center justify-center gap-1 p-2 text-center sm:p-5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
          >
            <span className="block w-full text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
            <span className={cn("block w-full whitespace-nowrap text-base font-bold sm:text-2xl", valueClassName)}>{value}</span>
            {sub != null && <span className="block w-full text-xs text-muted-foreground">{sub}</span>}
            <Info aria-hidden="true" className="mt-auto h-3 w-3 text-muted-foreground/70" />
          </button>
          <span id={infoId} className="sr-only">{info}</span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        className="w-auto max-w-[16rem] p-3 text-sm leading-relaxed"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // A tap on the tile itself is handled by its onClick (pin or unpin).
        // Letting Radix dismiss here would close the explainer first, and the
        // click would then re-open it.
        onPointerDownOutside={(e) => {
          if (wrapperRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        onPointerEnter={mouseOnly(cancelScheduledClose)}
        onPointerLeave={mouseOnly(scheduleHoverClose)}
      >
        {info}
      </PopoverContent>
    </Popover>
  );
};
