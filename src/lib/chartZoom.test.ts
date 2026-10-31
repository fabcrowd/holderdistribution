import { describe, expect, it } from "vitest";
import type { YAxisScale } from "./chartAxes";
import {
  KEY_PAN_FRACTION,
  KEY_ZOOM_FACTOR,
  Y_MAX_SPAN_RATIO,
  Y_MIN_SPAN_RATIO,
  zoomKeyIntent,
  applyYRange,
  axisDragSpanFactor,
  scaleYRange,
  type YRange,
  clampWindow,
  fullExtent,
  insideRect,
  minSpanFor,
  normalizeHidden,
  panWindow,
  pinchSpanFactor,
  plotFraction,
  shouldCaptureWheel,
  sliceWindow,
  toggleHidden,
  wheelSpanFactor,
  zoomWindow,
  type XRange,
} from "./chartZoom";
import { isEventInside, isFrameDoubleClick } from "./chartZoom";

const FULL: XRange = [0, 100];

describe("zoomWindow", () => {
  it("keeps the point under the cursor fixed", () => {
    const w = zoomWindow(FULL, null, 0.25, 0.5, 1)!;
    expect(w[1] - w[0]).toBeCloseTo(50);
    expect(w[0] + 0.25 * (w[1] - w[0])).toBeCloseTo(25);
  });

  it("zooms toward the right edge", () => {
    expect(zoomWindow(FULL, null, 1, 0.5, 1)).toEqual([50, 100]);
  });

  it("never exceeds the full range and returns null when fully zoomed out", () => {
    expect(zoomWindow(FULL, [40, 60], 0.5, 100, 1)).toBeNull();
    expect(zoomWindow(FULL, null, 0.5, 1.2, 1)).toBeNull();
  });

  it("respects the minimum span", () => {
    const w = zoomWindow(FULL, [40, 60], 0.5, 0.0001, 5)!;
    expect(w[1] - w[0]).toBeCloseTo(5);
  });

  it("clamps inside the data extent", () => {
    const left = zoomWindow(FULL, [0, 20], 0, 0.5, 1)!;
    expect(left[0]).toBeGreaterThanOrEqual(0);
    const right = zoomWindow(FULL, [80, 100], 1, 2, 1)!;
    expect(right[1]).toBeLessThanOrEqual(100);
  });

  it("treats a bad anchor as centred", () => {
    expect(zoomWindow(FULL, null, Number.NaN, 0.5, 1)).toEqual([25, 75]);
  });
});

describe("panWindow", () => {
  it("shifts by a fraction of the span and clamps at the edges", () => {
    expect(panWindow(FULL, [20, 40], 0.5)).toEqual([30, 50]);
    expect(panWindow(FULL, [80, 100], 1)).toEqual([80, 100]);
    expect(panWindow(FULL, [0, 20], -1)).toEqual([0, 20]);
  });
  it("does nothing when not zoomed", () => {
    expect(panWindow(FULL, null, 0.5)).toBeNull();
  });
});

describe("clampWindow", () => {
  it("drops a window that no longer fits and re-clamps one that partly does", () => {
    expect(clampWindow([0, 10], [0, 20])).toBeNull();
    expect(clampWindow([0, 50], [40, 60])).toEqual([30, 50]);
    expect(clampWindow(null, [1, 2])).toBeNull();
  });
});

describe("fullExtent / minSpanFor / sliceWindow", () => {
  it("needs at least two distinct x values", () => {
    expect(fullExtent([5])).toBeNull();
    expect(fullExtent([5, 5])).toBeNull();
    expect(fullExtent([3, Number.NaN, 9])).toEqual([3, 9]);
  });
  it("min span covers a few rows", () => {
    expect(minSpanFor([0, 90], 10, 4)).toBe(40);
  });
  it("slices rows inclusively and returns all rows for a null window", () => {
    const rows = [0, 1, 2, 3, 4].map((x) => ({ x }));
    expect(sliceWindow(rows, (r) => r.x, [1, 3]).map((r) => r.x)).toEqual([1, 2, 3]);
    expect(sliceWindow(rows, (r) => r.x, null)).toBe(rows);
    expect(sliceWindow(rows, (_, i) => i, [3, 4]).length).toBe(2);
  });
});

describe("gesture helpers", () => {
  it("maps the cursor to a plot fraction", () => {
    expect(plotFraction(150, 100, 300)).toBe(0.25);
    expect(plotFraction(50, 100, 300)).toBe(0);
    expect(plotFraction(10, 100, 100)).toBe(0.5);
  });
  it("detects points inside the plot", () => {
    const r = { left: 0, right: 10, top: 0, bottom: 10 };
    expect(insideRect(5, 5, r)).toBe(true);
    expect(insideRect(11, 5, r)).toBe(false);
  });
  it("wheel up zooms in, wheel down zooms out, and line mode is scaled", () => {
    expect(wheelSpanFactor(-100)).toBeLessThan(1);
    expect(wheelSpanFactor(100)).toBeGreaterThan(1);
    expect(wheelSpanFactor(-3, 1)).toBeCloseTo(wheelSpanFactor(-48, 0));
    expect(wheelSpanFactor(1e6)).toBeCloseTo(wheelSpanFactor(240));
  });
  it("pinch apart zooms in, pinch together zooms out", () => {
    expect(pinchSpanFactor(100, 200)).toBe(0.5);
    expect(pinchSpanFactor(200, 100)).toBe(2);
    expect(pinchSpanFactor(0, 100)).toBe(1);
  });
});

describe("shouldCaptureWheel (page scroll is never trapped)", () => {
  it("never captures when zoom is not meaningful", () => {
    expect(shouldCaptureWheel(false, false, -100, false)).toBe(false);
    expect(shouldCaptureWheel(false, true, -100, true)).toBe(false);
  });
  it("lets scroll-down pass through at full range", () => {
    expect(shouldCaptureWheel(true, false, 100, false)).toBe(false);
  });
  it("captures zoom-in at full range and any wheel while zoomed", () => {
    expect(shouldCaptureWheel(true, false, -100, false)).toBe(true);
    expect(shouldCaptureWheel(true, true, 100, false)).toBe(true);
  });
  it("always captures ctrl/meta (pinch or explicit zoom)", () => {
    expect(shouldCaptureWheel(true, false, 100, true)).toBe(true);
  });
});

describe("toggleHidden", () => {
  const keys = ["a", "b", "c"];
  it("hides and re-shows a series", () => {
    const hidden = toggleHidden(new Set(), "a", keys);
    expect([...hidden]).toEqual(["a"]);
    expect([...toggleHidden(hidden, "a", keys)]).toEqual([]);
  });
  it("always keeps at least one series visible", () => {
    let h: ReadonlySet<string> = new Set();
    h = toggleHidden(h, "a", keys);
    h = toggleHidden(h, "b", keys);
    const refused = toggleHidden(h, "c", keys);
    expect(refused).toBe(h);
    expect(keys.filter((k) => !refused.has(k))).toEqual(["c"]);
  });
  it("a single series can never be hidden", () => {
    expect(toggleHidden(new Set(), "a", ["a"]).size).toBe(0);
  });
  it("does not mutate its input", () => {
    const h = new Set<string>();
    toggleHidden(h, "a", keys);
    expect(h.size).toBe(0);
  });
});

describe("normalizeHidden", () => {
  it("drops keys that no longer exist and never hides everything", () => {
    expect([...normalizeHidden(new Set(["a", "gone"]), ["a", "b"])]).toEqual(["a"]);
    expect(normalizeHidden(new Set(["a", "b"]), ["a", "b"]).size).toBe(0);
  });
});

describe("axisDragSpanFactor", () => {
  it("shrinks the range when dragged toward the axis end and stretches it when dragged back", () => {
    expect(axisDragSpanFactor(100, 200)).toBeLessThan(1);
    expect(axisDragSpanFactor(-100, 200)).toBeGreaterThan(1);
    expect(axisDragSpanFactor(0, 200)).toBe(1);
  });

  it("is symmetric around zero drag and bounded to one full axis length per gesture", () => {
    expect(axisDragSpanFactor(50, 200) * axisDragSpanFactor(-50, 200)).toBeCloseTo(1);
    expect(axisDragSpanFactor(10_000, 200)).toBeCloseTo(axisDragSpanFactor(200, 200));
  });

  it("ignores a degenerate plot or a bad delta", () => {
    expect(axisDragSpanFactor(50, 0)).toBe(1);
    expect(axisDragSpanFactor(Number.NaN, 200)).toBe(1);
  });

  it("drives the X window: a right drag narrows the range around its centre", () => {
    const narrowed = zoomWindow(FULL, null, 0.5, axisDragSpanFactor(100, 200), 1)!;
    expect(narrowed[1] - narrowed[0]).toBeLessThan(100);
    expect((narrowed[0] + narrowed[1]) / 2).toBeCloseTo(50);
    expect(zoomWindow(FULL, narrowed, 0.5, axisDragSpanFactor(-200, 200), 1)).toBeNull();
  });
});

describe("scaleYRange", () => {
  const BASE: YRange = [100, 200];

  it("keeps the midpoint and scales the span", () => {
    expect(scaleYRange(BASE, 0.5, BASE)).toEqual([125, 175]);
    expect(scaleYRange([125, 175], 2, BASE)).toEqual([100, 200]);
  });

  it("clamps the span to the auto-fit range times the min and max ratios", () => {
    const [lo, hi] = scaleYRange(BASE, 0.0001, BASE);
    expect(hi - lo).toBeCloseTo(100 * Y_MIN_SPAN_RATIO);
    const [lo2, hi2] = scaleYRange(BASE, 1000, BASE);
    expect(hi2 - lo2).toBeCloseTo(100 * Y_MAX_SPAN_RATIO);
  });

  it("leaves the range alone for a neutral or invalid factor", () => {
    expect(scaleYRange([120, 180], 1, BASE)).toEqual([120, 180]);
    expect(scaleYRange([120, 180], Number.NaN, BASE)).toEqual([120, 180]);
  });

  it("can stretch past the data so the axis shows headroom", () => {
    const [lo, hi] = scaleYRange(BASE, 2, BASE);
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(200);
  });
});

describe("applyYRange", () => {
  const auto: YAxisScale = { domain: [98_000, 103_000], ticks: [98_000, 100_000, 102_000], baseline: 98_000 };

  it("returns the auto-fit scale when no manual range is set (reset)", () => {
    expect(applyYRange(auto, undefined)).toBe(auto);
  });

  it("replaces the domain and ticks with the manual range and reports its baseline", () => {
    const view = applyYRange(auto, [99_000, 101_000]);
    expect(view.domain).toEqual([99_000, 101_000]);
    expect(view.ticks.length).toBeGreaterThan(0);
    for (const t of view.ticks) expect(t >= 99_000 && t <= 101_000).toBe(true);
    expect(view.baseline).toBe(99_000);
  });

  it("reports no baseline when the manual range starts at zero", () => {
    expect(applyYRange(auto, [0, 500]).baseline).toBeNull();
  });
});

describe("isFrameDoubleClick", () => {
  it("is false when there was no previous pointerdown", () => {
    expect(isFrameDoubleClick(null, 1000)).toBe(false);
  });

  it("is true for two frame pointerdowns 100ms apart", () => {
    expect(isFrameDoubleClick(1000, 1100)).toBe(true);
  });

  it("is false for two pointerdowns 900ms apart", () => {
    expect(isFrameDoubleClick(1000, 1900)).toBe(false);
  });

  it("is true at exactly the window boundary", () => {
    expect(isFrameDoubleClick(1000, 1500)).toBe(true);
  });
});

describe("isEventInside", () => {
  const inside = {};
  const frame = { contains: (n: unknown) => n === inside };

  it("is true when the target is inside the frame", () => {
    expect(isEventInside(frame, inside)).toBe(true);
  });

  it("is false when the target is outside the frame", () => {
    expect(isEventInside(frame, {})).toBe(false);
  });

  it("is false for a null target", () => {
    expect(isEventInside(frame, null)).toBe(false);
  });

  it("is false when the frame is null", () => {
    expect(isEventInside(null, inside)).toBe(false);
  });
});

describe("zoomKeyIntent", () => {
  const k = (key: string, over: Partial<{ zoomed: boolean; frameFocused: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
    zoomKeyIntent({ key, zoomed: false, frameFocused: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...over });

  it("zooms with +/- and resets with 0 or Escape, wherever focus is inside the chart", () => {
    expect(k("+")).toEqual({ type: "zoom", factor: KEY_ZOOM_FACTOR });
    expect(k("=")).toEqual({ type: "zoom", factor: KEY_ZOOM_FACTOR });
    expect(k("-")).toEqual({ type: "zoom", factor: 1 / KEY_ZOOM_FACTOR });
    expect(k("0")).toEqual({ type: "reset" });
    expect(k("Escape")).toEqual({ type: "reset" });
  });
  it("leaves plain arrows to the plot so they step the tooltip", () => {
    expect(k("ArrowLeft", { zoomed: true })).toBeNull();
    expect(k("ArrowRight", { zoomed: true })).toBeNull();
  });
  it("pans a zoomed chart with Shift+arrows, or plain arrows when the frame itself has focus", () => {
    expect(k("ArrowLeft", { zoomed: true, shiftKey: true })).toEqual({ type: "pan", delta: -KEY_PAN_FRACTION });
    expect(k("ArrowRight", { zoomed: true, shiftKey: true })).toEqual({ type: "pan", delta: KEY_PAN_FRACTION });
    expect(k("ArrowRight", { zoomed: true, frameFocused: true })).toEqual({ type: "pan", delta: KEY_PAN_FRACTION });
    expect(k("ArrowRight", { zoomed: false, shiftKey: true })).toBeNull();
  });
  it("ignores browser shortcuts", () => {
    expect(k("+", { ctrlKey: true })).toBeNull();
    expect(k("0", { metaKey: true })).toBeNull();
    expect(k("-", { altKey: true })).toBeNull();
  });
});
