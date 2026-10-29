/**
 * Open/close state for a tap-, hover- and focus-triggered explainer.
 *
 * Kept free of React and the DOM so the interaction rules can be tested in
 * the node vitest environment. `pinned` means the explainer was opened by a
 * tap or click: hover-leave and blur no longer close it, only a second tap,
 * an outside tap or Escape does.
 */
export type TooltipState = { open: boolean; pinned: boolean };

export type TooltipEvent =
  | { type: "tap" }
  | { type: "hoverIn" }
  | { type: "hoverOut" }
  | { type: "focus" }
  | { type: "blur" }
  | { type: "dismiss" };

export const CLOSED_TOOLTIP_STATE: TooltipState = { open: false, pinned: false };

export const reduceTooltipState = (state: TooltipState, event: TooltipEvent): TooltipState => {
  switch (event.type) {
    case "tap":
      // A tap on a pinned-open explainer closes it; any other tap pins it open.
      return state.open && state.pinned ? CLOSED_TOOLTIP_STATE : { open: true, pinned: true };
    case "hoverIn":
    case "focus":
      return { open: true, pinned: state.pinned };
    case "hoverOut":
    case "blur":
      return state.pinned ? state : CLOSED_TOOLTIP_STATE;
    case "dismiss":
      return CLOSED_TOOLTIP_STATE;
  }
};
