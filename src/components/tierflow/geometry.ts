/**
 * Pure layout arithmetic for the tier migration field. No DOM, no React, no
 * measurement — every position is derived from a tier's INDEX (0..9) or a
 * side-tile's INDEX (0..3), so HTML tiles and the SVG line overlay read the
 * exact same numbers and can never drift apart the way a `getBoundingClientRect`
 * measurement (the old TierFlowDiagram's connector gutter) could. A past
 * layout was reverted after measured-pixel positions drifted; this module is
 * the guardrail against that recurring.
 *
 * Canvas layout (all units are CSS px at 1:1 — NOT an SVG viewBox that gets
 * scaled, since scaling would shrink printed numbers on narrow screens):
 *
 *   SOURCE tiles      LANE      TIER column      LANE      SINK tiles
 *   x  8 → 198         120      x 318 → 618        120      x 738 → 928
 *   (4 tiles: swap/    (migration lines           (10 tiers, CENTERED       (4 tiles: swap/
 *    LP/CEX/wallet)     fan through here           on x=468, equal           LP/CEX/wallet)
 *                       on both sides)              width)
 */

/**
 * TEL's historical 10 tiers (config/holder-tiers.default.json
 * `distributionTiers`). The diagram itself renders the ACTIVE project's tiers
 * (useTierGeometry → holderTiersFor(project)); this constant is the default
 * and what tests pin. Every row position below is index-based, so any tier
 * count lays out the same way — only the canvas height grows/shrinks.
 */
export const TIERS = [
  "500M+", "250M-500M", "100M-250M", "50M-100M", "25M-50M",
  "10M-25M", "5M-10M", "1M-5M", "250K-1M", "1-250K",
] as const;

export type TierLabel = (typeof TIERS)[number];

export const tierIndex = (label: string, tiers: readonly string[] = TIERS): number => tiers.indexOf(label);

/**
 * Display-only overrides for tier labels.
 *
 * The raw label strings above are JOIN KEYS — they index holder-transitions.json's
 * migration matrix and tier-outflows.json's per-tier cells, so renaming one in
 * the data would break the join until every dataset is regenerated.
 *
 * Currently empty: the bottom bucket's floor is 1 TEL (sub-1-TEL dust wallets
 * are deliberately excluded from every bucket — see
 * scripts/lib/holdersView.js and lessons.md "Sub-1-TEL Dust Wallets Are
 * Deliberately Excluded From Buckets, Not Counts"), so "1-250K" is accurate
 * as written and needs no override. Kept as infrastructure in case the floor
 * changes again — do not add a "1-250K" override back without also checking
 * the floor is actually 0 at that point.
 */
const TIER_DISPLAY_LABELS: Record<string, string> = {};

export const tierDisplayLabel = (label: string): string =>
  TIER_DISPLAY_LABELS[label] ?? label;

// --- Canvas ---
export const TOP_PAD = 28;
export const TIER_H = 44;
export const PITCH = 66; // vertical distance between two tiers' row tops
// Bottom pad is smaller than TOP_PAD (16px vs 28px) — the last row's own
// height already reads as visual weight at the bottom edge, so it doesn't
// need a full top-pad's worth of extra breathing room to feel balanced.
const BOTTOM_PAD = 16;
/** Canvas height for `n` tier rows (TEL's 10 -> 682). */
export const canvasHeight = (n: number): number => TOP_PAD + PITCH * (Math.max(1, n) - 1) + TIER_H + BOTTOM_PAD;
export const CANVAS_H = canvasHeight(TIERS.length); // 682

export const SRC_X = 8;
export const SRC_W = 190; // right edge 198
export const LANE_W = 120;
export const TIER_COL_X = SRC_X + SRC_W + LANE_W; // 318
export const TIER_COL_W = 300; // column slot; tiles (TIER_TILE_W) are centred in it
export const SINK_X = TIER_COL_X + TIER_COL_W + LANE_W; // 738
export const SINK_W = 190;
// Right-hand outer margin mirrors SRC_X on the left, for symmetric padding.
export const CANVAS_W = SINK_X + SINK_W + SRC_X; // 936

// Wallets mode has no side tiles, so the outer gutters are empty. Its useful
// span (tiles plus the ticks beside them and the migration lane arcs) is
// cropped out of the same coordinate space: nothing is re-positioned, the
// view is just offset by WALLETS_ORIGIN_X.
export const WALLETS_ORIGIN_X = 168;
export const WALLETS_W = 600; // x 168..768
export const canvasWidthFor = (metric: "wallets" | "tel"): number => (metric === "wallets" ? WALLETS_W : CANVAS_W);
export const canvasOriginX = (metric: "wallets" | "tel"): number => (metric === "wallets" ? WALLETS_ORIGIN_X : 0);

// --- Tier rows ---
export const rowTop = (i: number): number => TOP_PAD + PITCH * i;
export const rowCenterY = (i: number): number => rowTop(i) + TIER_H / 2;

// Every tier tile is the same width; the balance range's size is shown by a
// bar INSIDE the tile (tierBarFraction), so labels, counts and the +N / -N
// ticks fall in straight columns instead of a ragged pill outline.
export const TIER_TILE_W = 260;

export const tierLeftX = TIER_COL_X;
// Tiles are centred on TIER_COL_CENTER_X. tileEdgeX is the shared left/right
// edge every flow line, arc and tick attaches to.
export const TIER_COL_CENTER_X = TIER_COL_X + TIER_COL_W / 2; // 468
export const tileEdgeX = (side: "left" | "right"): number =>
  side === "left" ? TIER_COL_CENTER_X - TIER_TILE_W / 2 : TIER_COL_CENTER_X + TIER_TILE_W / 2;

/** Smallest filled share of the inner size bar, so the narrowest tier still shows a sliver. */
export const TIER_BAR_MIN_FRACTION = 0.06;
/** Fill fraction (0..1) of a tile's size bar from the 0-100 log-scaled pct. */
export const tierBarFraction = (pct: number): number => {
  if (!Number.isFinite(pct)) return TIER_BAR_MIN_FRACTION;
  return Math.max(TIER_BAR_MIN_FRACTION, Math.min(1, pct / 100));
};

// --- Side tiles (4 sources on the left, 4 sinks on the right — same y
// positions on both sides so a "came" and "went" row line up horizontally) ---
export const SIDE_COUNT = 4;
export const SIDE_H = 56;
export const SIDE_PITCH = 68;
// Centered on the tier stack's vertical span, not pinned to the top —
// 4 tiles at 68px pitch span 3*68+56 = 260px; center that within CANVAS_H.
// `canvasH` defaults to TEL's 682; the diagram passes the active project's.
export const sideTop = (j: number, canvasH: number = CANVAS_H): number =>
  Math.round((canvasH - (SIDE_H + SIDE_PITCH * (SIDE_COUNT - 1))) / 2) + SIDE_PITCH * j;
export const sideCenterY = (j: number, canvasH: number = CANVAS_H): number => sideTop(j, canvasH) + SIDE_H / 2;

// --- Bezier paths ---
// BEND fans a bundle of lines through the lane instead of pinching every line
// through one point midway (which would read as a single thick rope). A pure
// horizontal-tangent cubic: control points sit BEND of the way across at each
// endpoint's own y, so lines leave/arrive roughly perpendicular to the tile edge.
const BEND = 0.42;
export const bezierPath = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = (x2 - x1) * BEND;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

// Migration lines connect two TIER TILES on the SAME side of the canvas
// (both left edges, or both right edges), which share one x. A plain cubic between them would cut
// a diagonal straight through the tier column instead of arcing out through
// the lane. This bulges both control points out to a shared far-X (into the
// lane), so the curve leaves x1 and arrives at x2 each roughly perpendicular
// to its own tile edge — "arcs from and towards" both bars, touching each
// exactly at its real edge even when those edges sit at different x.
const laneArcFarX = (x1: number, y1: number, x2: number, y2: number, side: "left" | "right"): number => {
  const bulge = Math.min(LANE_W - 8, Math.max(16, Math.abs(y2 - y1) * 0.25));
  return side === "left" ? Math.min(x1, x2) - bulge : Math.max(x1, x2) + bulge;
};
export const laneArcPath = (x1: number, y1: number, x2: number, y2: number, side: "left" | "right"): string => {
  const farX = laneArcFarX(x1, y1, x2, y2, side);
  return `M ${x1} ${y1} C ${farX} ${y1}, ${farX} ${y2}, ${x2} ${y2}`;
};
/** Midpoint (t = 0.5) of laneArcPath: where an amount label sits on its own line. */
export const laneArcMid = (x1: number, y1: number, x2: number, y2: number, side: "left" | "right"): { x: number; y: number } => {
  const farX = laneArcFarX(x1, y1, x2, y2, side);
  return { x: (x1 + x2 + 6 * farX) / 8, y: (y1 + y2) / 2 };
};

// Spreads k=0..n-1 endpoints that would otherwise all land on the same y
// (e.g. 8 migration lines all touching the clicked tier's left edge) across
// a small span centered on `centerY`, so individual lines stay distinguishable
// right at the tile edge instead of converging to one point.
export const fanY = (centerY: number, k: number, n: number, span = 16): number => {
  if (n <= 1) return centerY;
  const step = Math.min(span / (n - 1), 8);
  return centerY + (k - (n - 1) / 2) * step;
};

// Stroke width on a ratio-to-max scale (not additive/proportional-to-sum),
// so two thin lines can never be eyeballed as summing to one thick line —
// each line's width only ever says "how big relative to the biggest line
// drawn right now", never a fraction of a whole.
export const strokeWidth = (value: number, maxValue: number): number => {
  if (maxValue <= 0 || value <= 0) return 0;
  return Math.max(1.25, Math.min(9, Math.sqrt(value / maxValue) * 9));
};

/**
 * Side-tile pivot lines: assign stroke width by volume RANK among the
 * positive values, stepping uniformly from `maxW` (largest) down to `minW`
 * (smallest). The number of steps equals the number of distinct magnitudes,
 * so ties share a width and the visual ladder always reads thick→thin in
 * even increments regardless of how skewed the raw volumes are.
 *
 * Returns a width parallel to each input value (0 for non-positive).
 */
export const rankedStrokeWidths = (
  values: readonly number[],
  maxW = 10,
  minW = 1.5,
): number[] => {
  const positive = values
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);

  const out = values.map(() => 0);
  if (positive.length === 0) return out;

  const rankOf = new Map<number, number>();
  let nextRank = 0;
  for (const { v } of positive) {
    if (!rankOf.has(v)) rankOf.set(v, nextRank++);
  }
  const rankCount = nextRank;

  for (const { v, i } of positive) {
    const r = rankOf.get(v)!;
    out[i] = rankCount <= 1
      ? maxW
      : maxW - (r / (rankCount - 1)) * (maxW - minW);
  }
  return out;
};
