import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type InfoTipProps = {
  /** Explainer. Strings honour \n as paragraph breaks. */
  content: ReactNode;
  /** Accessible name of the trigger, e.g. "About Tier flows". */
  label?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  iconClassName?: string;
  /** Custom trigger content; defaults to the (i) icon. */
  children?: ReactNode;
};

/**
 * The (i) explainer used across the page. A Radix Tooltip only opens on hover
 * and keyboard focus — on a phone a tap did nothing, and on desktop a click
 * closed it — so this is a Popover that:
 *   - opens on click / tap (and stays open until dismissed: outside click,
 *     Escape, or a second click),
 *   - also previews on mouse hover, closing when the pointer leaves unless it
 *     was pinned open by a click,
 *   - has a 24x24px hit area (WCAG 2.5.8) around a 14px glyph.
 */
export const InfoTip = ({
  content,
  label = "More information",
  side = "bottom",
  align = "center",
  className = "",
  iconClassName = "h-3.5 w-3.5",
  children,
}: InfoTipProps) => {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (!pinned.current) setOpen(false);
    }, 120);
  };
  useEffect(() => cancelClose, []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) pinned.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-infotip=""
          onClick={(e) => {
            // Inside clickable rows / tiles the explainer must not also
            // trigger the row.
            e.stopPropagation();
            e.preventDefault();
            cancelClose();
            if (open && pinned.current) {
              pinned.current = false;
              setOpen(false);
            } else {
              pinned.current = true;
              setOpen(true);
            }
          }}
          onPointerEnter={(e) => {
            if (e.pointerType !== "mouse") return;
            cancelClose();
            setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse") return;
            scheduleClose();
          }}
          className={`relative inline-flex h-6 w-6 shrink-0 items-center before:absolute before:-inset-2.5 before:content-[''] before:xl:hidden justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
        >
          {children ?? <Info className={iconClassName} aria-hidden="true" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        collisionPadding={12}
        className="w-auto max-w-xs max-h-[70svh] overflow-y-auto whitespace-pre-line p-3 text-sm leading-relaxed"
        onPointerEnter={(e) => e.pointerType === "mouse" && cancelClose()}
        onPointerLeave={(e) => e.pointerType === "mouse" && scheduleClose()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
};
