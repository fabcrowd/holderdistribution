/**
 * Holders dashboard chart sizing for the desktop terminal.
 *
 * The previous grid was 2 rows × 7 panels inside a viewport that never
 * scrolled. At 1280×800 each chart body was 296px:
 *
 *   main = 800 − 56 title bar − 24 status line − 16 padding = 704
 *   row  = (704 − 8 gap) / 2 = 348
 *   body = 348 − 36 panel header − 16 body padding = 296
 *
 * Primary charts (retail holder count, balance held) now share one 2-up row
 * whose height is clamped so the body stays in a readable band at 1280–1440.
 * Staking, exchange flow and wallet sizes, then the two tables, continue
 * below. The terminal main region scrolls; tables still scroll inside panels.
 */

export const TERMINAL_TITLEBAR_PX = 56; // h-14
export const TERMINAL_STATUS_PX = 24; // h-6
export const TERMINAL_MAIN_PAD_PX = 16; // p-2
export const PANEL_HEADER_PX = 36; // h-9
export const PANEL_BODY_PAD_PX = 16; // p-2
export const GRID_GAP_PX = 8;

/** Plain-language strip under the title bar (sentence + trend row). */
export const TERMINAL_HEADLINE_PX = 64;

/** How much of the next row stays in view so the fold doesn't look final. */
export const PRIMARY_PEEK_PX = 72;

/** 28rem. Chart body ≈ 396px — already above the old 296px squeeze. */
export const PRIMARY_ROW_MIN_PX = 448;
/** 36rem. Chart body ≈ 524px. Taller viewports stop growing the row here. */
export const PRIMARY_ROW_MAX_PX = 576;

/** 22rem. Secondary charts (staking, exchange flow, wallet sizes). */
export const SECONDARY_CHART_ROW_PX = 352;
/** 22rem. Concentration + exchange tables; the body scrolls inside. */
export const TABLE_PANEL_PX = 352;

/** Chart body inside a panel of `panelPx` (header + body padding). */
export const chartBodyPx = (panelPx: number): number => panelPx - PANEL_HEADER_PX - PANEL_BODY_PAD_PX;

const primaryChromePx = () =>
  TERMINAL_TITLEBAR_PX + TERMINAL_HEADLINE_PX + TERMINAL_STATUS_PX + TERMINAL_MAIN_PAD_PX + PRIMARY_PEEK_PX;

/**
 * Chart-body height the old 2×7 grid produced at `viewportHeight`.
 * 800px → 296. Used to pin the "squished" baseline the new row replaces.
 */
export const legacyChartBodyPx = (viewportHeight: number): number => {
  const main = viewportHeight - TERMINAL_TITLEBAR_PX - TERMINAL_STATUS_PX - TERMINAL_MAIN_PAD_PX;
  const row = (main - GRID_GAP_PX) / 2;
  return Math.round(chartBodyPx(row));
};

/**
 * Primary-row height for a viewport. Preferred size leaves the title bar,
 * headline strip, status line, padding and a peek of the next row; then
 * clamps into [PRIMARY_ROW_MIN_PX, PRIMARY_ROW_MAX_PX].
 */
export const holdersPrimaryRowPx = (viewportHeight: number): number => {
  const preferred = viewportHeight - primaryChromePx();
  return Math.round(Math.min(PRIMARY_ROW_MAX_PX, Math.max(PRIMARY_ROW_MIN_PX, preferred)));
};

/** CSS height matching `holdersPrimaryRowPx` (100dvh, no JS measurement). */
export const HOLDERS_PRIMARY_ROW_HEIGHT = `clamp(${PRIMARY_ROW_MIN_PX}px, calc(100dvh - ${primaryChromePx()}px), ${PRIMARY_ROW_MAX_PX}px)`;
