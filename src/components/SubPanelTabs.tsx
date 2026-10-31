import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { prefersReducedMotion } from "@/lib/motion";
import { type ScrollEdges, revealActiveTab, scrollEdges, scrollStepPx } from "@/lib/tabScroll";

export type SubPanel = { id: string; label: string; title?: string };

type SubPanelTabsProps = {
  panels: SubPanel[];
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  /** Extra classes for the row holding the selector — e.g. page gutters. */
  className?: string;
  /** Rendered at the right end of the selector row, on the same line. Used in
   *  focus mode to fold the chain filter into this row: two full-width control
   *  rows stacked cost ~135px of desktop viewport above the chart, and the
   *  selector row is mostly empty space past the last label anyway. */
  trailing?: ReactNode;
  /** "filter": compact segmented toggle for a third-level choice. */
  variant?: "underline" | "filter";
};

/**
 * Second-level navigation inside a widget that would otherwise be one long
 * stack.
 *
 * Deliberately an UNDERLINE bar, not a pill group. The first version of this
 * used the filled segmented-control treatment from TierFlowDiagram, and on
 * screen the result was backwards: the page-level tab (a pale tinted pill) sat
 * above a solid-primary sub-panel pill, so the subordinate control read as the
 * louder of the two. Pills also put a third pill row on the Distribution tab,
 * which already has two inside TierFlowDiagram. An underline is a different
 * KIND of control from a pill, so it cannot compete on weight no matter what
 * accent the tab above it uses, and it reads as "sections within this card".
 *
 * The row scrolls horizontally rather than wrapping: a wrapped selector costs
 * a second row of chrome above the data on a phone, which is exactly the
 * mistake the page-level `grid-cols-2` TabsList made (~94px). `w-max min-w-full`
 * keeps the baseline rule spanning the card even when the labels don't fill it.
 *
 * Inactive TabsContent unmounts, so the charts in hidden panels are not in the
 * DOM at all — that is the point, not just the reduced scroll height.
 */
/** Above this many sections a phone gets a native "Section" picker instead of
 *  a sideways-scrolling strip whose later items are off-screen and unseen. */
export const SELECT_THRESHOLD = 4;

const NO_EDGES: ScrollEdges = { overflowing: false, left: false, right: false };

const sameEdges = (a: ScrollEdges, b: ScrollEdges): boolean =>
  a.overflowing === b.overflowing && a.left === b.left && a.right === b.right;

const scrollButtonClass =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const SubPanelTabs = ({
  panels,
  value,
  onValueChange,
  children,
  className = "",
  trailing,
  variant = "underline",
}: SubPanelTabsProps) => {
  const useSelect = variant === "underline" && panels.length > SELECT_THRESHOLD;
  const selectId = useId();
  const showStrip = variant !== "filter";
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastRevealedValue = useRef<string | undefined>(undefined);
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);

  const syncEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = scrollEdges({ scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    setEdges((prev) => (sameEdges(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    syncEdges();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncEdges);
      return () => window.removeEventListener("resize", syncEdges);
    }
    // Observing the list too catches a panel count change, which resizes content but not the scroller.
    const observer = new ResizeObserver(syncEdges);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [showStrip, syncEdges]);

  useEffect(() => {
    const strip = scrollerRef.current;
    if (!strip) return;
    // Animate only when the user changed tabs; the mount/first-overflow reveal is instant.
    const tabChanged = lastRevealedValue.current !== undefined && lastRevealedValue.current !== value;
    revealActiveTab(strip, prefersReducedMotion() || !tabChanged);
    lastRevealedValue.current = value;
  }, [value, showStrip, edges.overflowing]);

  const nudge = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction * scrollStepPx(el.clientWidth),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <Tabs value={value} onValueChange={onValueChange}>
      <div className={`flex items-end gap-3 ${className}`}>
        {useSelect && (
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:hidden">
            <label htmlFor={selectId} className="shrink-0 text-xs font-semibold text-muted-foreground">
              Section
            </label>
            <select
              id={selectId}
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              className="h-11 min-w-0 flex-1 rounded-md border border-border bg-card px-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {panels.map((p) => (
                <option key={p.id} value={p.id} title={p.title}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {variant === "filter" ? (
          // Third-level choice (e.g. Wallets / Balance / Staked inside a
          // panel) reads as a filter on the chart, not more navigation.
          <TabsList className="inline-flex h-auto w-auto gap-0.5 rounded-md border border-border/60 bg-muted/40 p-0.5">
            {panels.map((panel) => (
              <TabsTrigger
                key={panel.id}
                value={panel.id}
                title={panel.title}
                className="min-h-[32px] max-xl:min-h-11 rounded px-3 text-xs font-semibold text-muted-foreground hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-primary data-[state=active]:shadow-sm"
              >
                {panel.label}
              </TabsTrigger>
            ))}
          </TabsList>
        ) : (
          <div className={`flex min-w-0 flex-1 items-center ${useSelect ? "hidden sm:flex" : ""}`}>
            {edges.overflowing && (
              <button
                type="button"
                aria-label="Scroll tabs left"
                // aria-disabled, not disabled: a disabled button that has focus drops it to <body>.
                aria-disabled={!edges.left}
                onClick={() => edges.left && nudge(-1)}
                className={scrollButtonClass}
              >
                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
            <div className="relative min-w-0 flex-1">
            <div ref={scrollerRef} onScroll={syncEdges} className="scroll-px-8 overflow-x-auto [-webkit-overflow-scrolling:touch]">
            <TabsList className="inline-flex h-auto w-max min-w-full flex-nowrap justify-start gap-1 max-sm:pr-7 rounded-none border-b border-border/60 bg-transparent p-0">
              {panels.map((panel) => (
                <TabsTrigger
                  key={panel.id}
                  value={panel.id}
                  title={panel.title}
                  className="min-h-[44px] whitespace-nowrap rounded-none border-b-2 border-transparent bg-transparent px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none sm:text-sm"
                >
                  {panel.label}
                </TabsTrigger>
              ))}
            </TabsList>
            </div>
            {edges.left && (
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-card to-transparent" />
            )}
            {edges.right && (
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent" />
            )}
            </div>
            {edges.overflowing && (
              <button
                type="button"
                aria-label="Scroll tabs right"
                aria-disabled={!edges.right}
                onClick={() => edges.right && nudge(1)}
                className={scrollButtonClass}
              >
                <ChevronRight className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {trailing ? <div className="shrink-0 pb-1">{trailing}</div> : null}
      </div>
      {children}
    </Tabs>
  );
};
