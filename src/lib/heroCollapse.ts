export type HeroCollapseState = {
  /** True after the hero has scrolled behind the sticky bar at least once. */
  latched: boolean;
  /** Click-to-expand override. Cleared the next time the hero scrolls out of view. */
  userExpanded: boolean;
};

export const HERO_COLLAPSE_INITIAL: HeroCollapseState = {
  latched: false,
  userExpanded: false,
};

export type HeroCollapseEvent = "scroll-past" | "scroll-back" | "toggle" | "select";

/**
 * Collapse is a one-way latch for the rest of the page visit: scrolling back
 * to the top does not reopen the hero. Click toggles after the first latch.
 * Scrolling past again while expanded re-collapses it (the user already
 * chose the compact strip once this visit).
 */
export function reduceHeroCollapse(
  state: HeroCollapseState,
  event: HeroCollapseEvent,
): HeroCollapseState {
  switch (event) {
    case "scroll-past":
      return { latched: true, userExpanded: false };
    case "scroll-back":
      return state;
    case "toggle":
      if (!state.latched) return state;
      return { ...state, userExpanded: !state.userExpanded };
    // Picking a headline tile collapses the hero the same way scrolling past
    // it does. The tile is a destination, so the strip it leaves behind is the
    // navigation — keeping the hero open would push the charts the click just
    // asked for below the fold, which is the problem the click was solving.
    case "select":
      return { latched: true, userExpanded: false };
  }
}

export function isHeroCollapsed(state: HeroCollapseState): boolean {
  return state.latched && !state.userExpanded;
}
