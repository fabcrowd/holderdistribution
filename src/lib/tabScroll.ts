export type ScrollEdges = { overflowing: boolean; left: boolean; right: boolean };
export type ScrollMetrics = { scrollLeft: number; scrollWidth: number; clientWidth: number };

/** Subpixel layout can leave a fraction of a pixel short of the true far end. */
const EDGE_TOLERANCE_PX = 1;
const SCROLL_STEP_RATIO = 0.6;
const NO_EDGES: ScrollEdges = { overflowing: false, left: false, right: false };

/** Which edges of a tab strip still hide tabs, so the fades and chevrons know. */
export const scrollEdges = ({ scrollLeft, scrollWidth, clientWidth }: ScrollMetrics): ScrollEdges => {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= EDGE_TOLERANCE_PX) return NO_EDGES;
  return {
    overflowing: true,
    left: scrollLeft > EDGE_TOLERANCE_PX,
    right: scrollLeft < maxScroll - EDGE_TOLERANCE_PX,
  };
};

export const scrollStepPx = (clientWidth: number): number => Math.round(clientWidth * SCROLL_STEP_RATIO);

/** Brings the selected tab into view. Radix marks it with aria-selected. */
export const revealActiveTab = (strip: HTMLElement, reduced: boolean): void => {
  const active = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  active?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduced ? "auto" : "smooth" });
};
