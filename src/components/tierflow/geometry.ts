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
 *    LP/CEX/wallet)     fan through here           on x=468, growing         LP/CEX/wallet)
 *                       on both sides)              left+right by value)
 */

export const TIERS = [
  "500M+", "250M-500M", "100M-250M", "50M-100M", "25M-50M",
  "10M-25M", "5M-10M", "1M-5M", "250K-1M", "1-250K",
] as const;

export type TierLabel = (typeof TIERS)[number];

export const tierIndex = (label: string): number => TIERS.indexOf(label as TierLabel);

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
export const CANVAS_H = TOP_PAD + PITCH * (TIERS.length - 1) + TIER_H + BOTTOM_PAD; // 682

export const SRC_X = 8;
export const SRC_W = 190; // right edge 198
export const LANE_W = 120;
export const TIER_COL_X = SRC_X + SRC_W + LANE_W; // 318
export const TIER_COL_W = 300; // nominal — actual bar right edge is ragged (tileW is data-driven)
export const SINK_X = TIER_COL_X + TIER_COL_W + LANE_W; // 738
export const SINK_W = 190;
// Right-hand outer margin mirrors SRC_X on the left, for symmetric padding.
export const CANVAS_W = SINK_X + SINK_W + SRC_X; // 936

// --- Tier rows ---
export const rowTop = (i: number): number => TOP_PAD + PITCH * i;
export const rowCenterY = (i: number): number => rowTop(i) + TIER_H / 2;

// Bar width in px from a 0-100 log-scaled percentage (see useFlowField's
// barPct, lifted verbatim from the pre-redesign component). Floor of 170px
// keeps even a 3%-scaled tier (500M+, 2 wallets) wide enough for its full
// label, printed count and net change (104px truncated labels to "50…");
// ceiling of 300px matches TIER_COL_W's nominal width.
export const tileW = (pct: number): number => 170 + (130 * Math.max(0, Math.min(100, pct))) / 100;

export const tierLeftX = TIER_COL_X;
// Tier bars are CENTER-aligned, not left-aligned: every tier's bar shares the
// same horizontal center line and grows outward left/right by equal amounts
// as its value grows, rather than all starting flush at TIER_COL_X and only
// ever extending rightward. TIER_COL_CENTER_X is the fixed center every bar
// shares; tileEdgeX takes an already-computed WIDTH (not a raw pct — the
// caller may have rescaled pct against the tallest bar first) and returns
// that bar's own left or right edge around the shared center.
export const TIER_COL_CENTER_X = TIER_COL_X + TIER_COL_W / 2; // 468
export const tileEdgeX = (width: number, side: "left" | "right"): number =>
  side === "left" ? TIER_COL_CENTER_X - width / 2 : TIER_COL_CENTER_X + width / 2;

// --- Side tiles (4 sources on the left, 4 sinks on the right — same y
// positions on both sides so a "came" and "went" row line up horizontally) ---
export const SIDE_COUNT = 4;
export const SIDE_H = 56;
export const SIDE_PITCH = 68;
// Centered on the tier stack's vertical span, not pinned to the top —
// 4 tiles at 68px pitch span 3*68+56 = 260px; center that within CANVAS_H.
export const sideTop = (j: number): number => Math.round((CANVAS_H - (SIDE_H + SIDE_PITCH * (SIDE_COUNT - 1))) / 2) + SIDE_PITCH * j;
export const sideCenterY = (j: number): number => sideTop(j) + SIDE_H / 2;

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
// (both left edges, or both right edges) — but tile widths are data-driven,
// so two right edges rarely share an x. A plain cubic between them would cut
// a diagonal straight through the tier column instead of arcing out through
// the lane. This bulges both control points out to a shared far-X (into the
// lane), so the curve leaves x1 and arrives at x2 each roughly perpendicular
// to its own tile edge — "arcs from and towards" both bars, touching each
// exactly at its real edge even when those edges sit at different x.
export const laneArcPath = (x1: number, y1: number, x2: number, y2: number, side: "left" | "right"): string => {
  const bulge = Math.min(LANE_W - 8, Math.max(16, Math.abs(y2 - y1) * 0.25));
  const farX = side === "left" ? Math.min(x1, x2) - bulge : Math.max(x1, x2) + bulge;
  return `M ${x1} ${y1} C ${farX} ${y1}, ${farX} ${y2}, ${x2} ${y2}`;
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
