/**
 * Single source of truth for terminal sizing: chart height tiers, the spacing
 * scale, the type scale and the one Recharts tick style.
 *
 * Rows no longer have fixed pixel heights. A chart panel's body takes a height
 * TIER; a table panel takes its content's height; the grid row is as tall as
 * its tallest panel. So a 7-bar chart and an 8-row table are each sized by
 * what they hold, and tables never scroll inside a fixed box.
 */

/** Spacing scale (px): 8 / 12 / 16 / 24. Tailwind: 2 / 3 / 4 / 6. */
export const SPACE_PX = { xs: 8, sm: 12, md: 16, lg: 24 } as const;
export const PANEL_PADDING_PX = SPACE_PX.sm;
export const GRID_GAP_PX = SPACE_PX.sm;
export const SECTION_GAP_PX = SPACE_PX.lg;

/** Type scale (px, desktop). Nothing below 12. */
export const TYPE_PX = {
  kpiValue: 28, // semibold
  panelStat: 18,
  panelTitle: 13,
  body: 14,
  axisTick: 12,
  caption: 12,
} as const;
export const MIN_FONT_PX = 12;

/**
 * Chart body heights. `hero` follows the viewport inside a band; `standard`
 * and `compact` are fixed. Each is the height of the whole panel body
 * (padding included), so a chart gets this minus 2 x PANEL_PADDING_PX.
 */
export const CHART_HEIGHT = {
  hero: "clamp(420px, 55dvh, 560px)",
  standard: "300px",
  compact: "200px",
} as const;
export type ChartTier = keyof typeof CHART_HEIGHT;

/** Tailwind classes for the same tiers (static strings so the JIT sees them). */
export const CHART_HEIGHT_CLASS = {
  hero: "h-[clamp(420px,55dvh,560px)]",
  standard: "h-[300px]",
  compact: "h-[200px]",
} as const;

/** The one axis-tick style for every Recharts chart. */
export const CHART_TICK = { fill: "hsl(var(--muted-foreground))", fontSize: TYPE_PX.axisTick } as const;
/** In-plot labels (reference lines, bar values). */
export const CHART_LABEL_FONT_PX = TYPE_PX.caption;
