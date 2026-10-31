/** Selector for a tier's tile (or phone row button) inside the tier-flow diagram. */
export const tierTileSelector = (label: string): string => {
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(label) : label.replace(/["\\]/g, "\\$&");
  return `[data-testid="tier-flow"] [data-tier="${escaped}"]`;
};

/**
 * Closing the detail (Clear or the rail's close button) unmounts the control
 * that had focus, which drops it on <body>. Send it to the tier that was
 * selected instead. Returns whether a tile was focused.
 */
export const focusTierTile = (label: string | null | undefined, doc?: Document): boolean => {
  if (!label) return false;
  const tile = (doc ?? document).querySelector<HTMLElement>(tierTileSelector(label));
  if (!tile) return false;
  tile.focus({ preventScroll: true });
  return true;
};
