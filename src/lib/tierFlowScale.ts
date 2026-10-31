/**
 * How much the tier-flow canvas shrinks to fit its panel.
 *
 * Tile labels are laid out at 1:1 CSS pixels (see tierflow/geometry.ts —
 * "scaling would shrink printed numbers"). The terminal used to fit BOTH
 * the 936×682 canvas axes into the cell, which at 1280px (a 7-column
 * panel) landed near 0.75 and, in a short cell, as low as ~0.6 — 13px
 * type at ~8px. Terminal now fits the WIDTH only and never goes below
 * READABLE_TIER_SCALE; a canvas taller than the cell scrolls inside it.
 * Stacked (page) layout is unchanged: fit the width, floor 0.2.
 */

/** 13px labels stay ≥ ~12px. Below this the diagram was hard to read. */
export const READABLE_TIER_SCALE = 0.92;
export const MIN_STACKED_SCALE = 0.2;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function tierCanvasScale(args: {
  terminal: boolean;
  clientWidth: number;
  clientHeight: number;
  canvasW: number;
  canvasH: number;
  /** Floor override: the canvas overflows (scrolls) rather than shrink below it. */
  minScale?: number;
}): number {
  const { terminal, clientWidth, canvasW, minScale } = args;
  if (!(clientWidth > 0) || !(canvasW > 0)) return 1;
  const byWidth = clientWidth / canvasW;
  if (!terminal) return clamp(byWidth, minScale ?? MIN_STACKED_SCALE, 1);
  // Height is intentionally ignored: fitting it is what crushed the type.
  return clamp(Math.min(1, byWidth), minScale ?? READABLE_TIER_SCALE, 1);
}
