/**
 * Pure math for chart zoom/pan and series toggling, shared by every chart.
 *
 * A zoom `window` is a [lo, hi] range in the chart's own X units (epoch ms for
 * time charts, row index for category charts). `null` means "full range".
 */

export type XRange = readonly [number, number];

/** Rows needed before zoom is worth offering. */
export const MIN_ZOOMABLE_ROWS = 8;
/** Never zoom in below this many rows. */
export const MIN_VISIBLE_ROWS = 4;
/** Wheel sensitivity: span multiplier = exp(deltaY * WHEEL_ZOOM_RATE). */
export const WHEEL_ZOOM_RATE = 0.0015;
/** Keyboard / button zoom step (span multiplier when zooming in). */
export const KEY_ZOOM_FACTOR = 0.7;
/** Keyboard pan step as a fraction of the visible span. */
export const KEY_PAN_FRACTION = 0.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Full X extent of a sorted list of X values, or null when there is no span. */
export const fullExtent = (xs: readonly number[]): XRange | null => {
  const finite = xs.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  return hi > lo ? [lo, hi] : null;
};

/** Smallest span that still shows `minRows` rows of an evenly spaced series. */
export const minSpanFor = (full: XRange, rowCount: number, minRows = MIN_VISIBLE_ROWS): number => {
  const gaps = Math.max(rowCount - 1, 1);
  return ((full[1] - full[0]) / gaps) * Math.min(minRows, gaps);
};

/**
 * Zoom around `anchorFrac` (0 = left edge of the plot, 1 = right edge) by
 * multiplying the visible span by `spanFactor` (<1 zooms in, >1 zooms out).
 * Returns null once the result covers the full range.
 */
export const zoomWindow = (
  full: XRange,
  current: XRange | null,
  anchorFrac: number,
  spanFactor: number,
  minSpan: number,
): XRange | null => {
  const [fLo, fHi] = full;
  const fullSpan = fHi - fLo;
  const [lo, hi] = current ?? full;
  const span = hi - lo;
  const frac = clamp(Number.isFinite(anchorFrac) ? anchorFrac : 0.5, 0, 1);
  const newSpan = clamp(span * spanFactor, Math.min(minSpan, fullSpan), fullSpan);
  if (newSpan >= fullSpan * 0.999) return null;
  const anchor = lo + frac * span;
  const newLo = clamp(anchor - frac * newSpan, fLo, fHi - newSpan);
  return [newLo, newLo + newSpan];
};

/** Shift the window by `deltaFrac` of its own span (positive = toward later X). */
export const panWindow = (full: XRange, current: XRange | null, deltaFrac: number): XRange | null => {
  if (!current) return null;
  const span = current[1] - current[0];
  const newLo = clamp(current[0] + deltaFrac * span, full[0], full[1] - span);
  return [newLo, newLo + span];
};

/** Re-clamp a window after the underlying data changed; null if it no longer fits. */
export const clampWindow = (full: XRange | null, current: XRange | null): XRange | null => {
  if (!full || !current) return null;
  const span = current[1] - current[0];
  if (span >= full[1] - full[0]) return null;
  const lo = clamp(current[0], full[0], full[1] - span);
  return [lo, lo + span];
};

/** Rows whose X lies inside the window (inclusive). Full range returns the input. */
export const sliceWindow = <T,>(rows: readonly T[], getX: (row: T, index: number) => number, window: XRange | null): T[] => {
  if (!window) return rows as T[];
  return rows.filter((r, i) => {
    const x = getX(r, i);
    return x >= window[0] && x <= window[1];
  });
};

/** Fraction (0..1) of `clientX` across a plot spanning [left, right]. */
export const plotFraction = (clientX: number, left: number, right: number): number =>
  right > left ? clamp((clientX - left) / (right - left), 0, 1) : 0.5;

/** True when `clientX/Y` lies inside the rectangle. */
export const insideRect = (x: number, y: number, r: { left: number; right: number; top: number; bottom: number }): boolean =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/** Span multiplier for a wheel tick (negative deltaY = scroll up = zoom in). */
export const wheelSpanFactor = (deltaY: number, deltaMode = 0): number => {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(clamp(px, -240, 240) * WHEEL_ZOOM_RATE);
};

/** Span multiplier for a pinch: fingers moving apart (ratio > 1) zoom in. */
export const pinchSpanFactor = (prevDistance: number, nextDistance: number): number =>
  prevDistance > 0 && nextDistance > 0 ? clamp(prevDistance / nextDistance, 0.2, 5) : 1;

/**
 * Should a wheel event be captured (preventDefault) or left to scroll the page?
 * Zooming out when already fully zoomed out does nothing, so it scrolls the page.
 */
export const shouldCaptureWheel = (zoomable: boolean, zoomed: boolean, deltaY: number, ctrlOrMeta: boolean): boolean => {
  if (!zoomable) return false;
  if (ctrlOrMeta) return true; // trackpad pinch / explicit zoom gesture
  return zoomed || deltaY < 0;
};

// --- Series toggling ---------------------------------------------------------

/**
 * Toggle one series in the hidden set. At least one series always stays
 * visible: hiding the last visible one is a no-op.
 */
export const toggleHidden = (hidden: ReadonlySet<string>, key: string, allKeys: readonly string[]): ReadonlySet<string> => {
  const next = new Set(hidden);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  const stillVisible = allKeys.filter((k) => k !== key && !next.has(k));
  if (stillVisible.length === 0) return hidden;
  next.add(key);
  return next;
};

/** Drop hidden keys that no longer exist (series changed) and keep one visible. */
export const normalizeHidden = (hidden: ReadonlySet<string>, allKeys: readonly string[]): ReadonlySet<string> => {
  const kept = allKeys.filter((k) => hidden.has(k));
  return kept.length >= allKeys.length ? new Set() : kept.length === hidden.size ? hidden : new Set(kept);
};
