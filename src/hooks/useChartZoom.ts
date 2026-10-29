import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  KEY_PAN_FRACTION,
  KEY_ZOOM_FACTOR,
  MIN_ZOOMABLE_ROWS,
  applyYRange,
  clampWindow,
  fullExtent,
  insideRect,
  minSpanFor,
  panWindow,
  pinchSpanFactor,
  plotFraction,
  scaleYRange,
  shouldCaptureWheel,
  sliceWindow,
  wheelSpanFactor,
  zoomWindow,
  type XRange,
  type YRange,
} from "@/lib/chartZoom";
import type { AxisSide, YAxisScale } from "@/lib/chartAxes";

const DRAG_THRESHOLD_PX = 4;
/** Sideways trackpad swipe step, as a fraction of the visible span. */
const WHEEL_PAN_FRACTION = 0.05;
/** Recharts draws the plot area as this group; the wheel only zooms over it. */
const PLOT_SELECTOR = ".recharts-cartesian-grid";

type Point = { x: number; y: number };

/** Manual Y ranges set by axis-strip drags; a side missing here is auto-fitted. */
export type YRanges = Partial<Record<AxisSide, YRange>>;

export type ChartZoom<T> = {
  /** Rows inside the zoom window (all rows when not zoomed). */
  rows: T[];
  /** Enough rows for zoom to mean something. */
  zoomable: boolean;
  /** True when the X window or any manual Y range is set. */
  zoomed: boolean;
  window: XRange | null;
  yRanges: YRanges;
  reset: () => void;
  zoomBy: (spanFactor: number, anchorFrac?: number) => void;
  panBy: (deltaFrac: number) => void;
  /** Stretch or shrink one Y axis around its midpoint; `base` is its auto-fit range. */
  dragY: (side: AxisSide, spanFactor: number, base: YRange) => void;
  /** The auto-fit Y scale, replaced by a manual range when the user dragged that axis. */
  yScale: (side: AxisSide, scale: YAxisScale) => YAxisScale;
  /** Callback ref: the frame can mount later than the hook (loading states). */
  containerRef: (node: HTMLDivElement | null) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
};

export const plotRect = (node: HTMLElement): DOMRect => {
  const grid = node.querySelector(PLOT_SELECTOR);
  return (grid ?? node).getBoundingClientRect();
};

/**
 * Zoom + pan for any Recharts chart whose rows have a numeric X (epoch ms for
 * time charts, or the row index for category charts). The chart simply renders
 * `zoom.rows`, so every axis, including Y, rescales to what is visible.
 *
 * Gestures: wheel over the plot (cursor-centred), drag to pan, double-click or
 * Escape to reset, +/-/arrows from the keyboard, two-finger pinch on touch.
 * The wheel is only captured over the plot area and only when it would change
 * the zoom, so page scrolling is never trapped.
 */
export const useChartZoom = <T,>(rowsIn: readonly T[], getX: (row: T, index: number) => number): ChartZoom<T> => {
  const getXRef = useRef(getX);
  getXRef.current = getX;
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((n: HTMLDivElement | null) => {
    nodeRef.current = n;
    setNode(n);
  }, []);
  const [win, setWin] = useState<XRange | null>(null);
  const [yRanges, setYRanges] = useState<YRanges>({});
  const yRef = useRef<YRanges>(yRanges);

  const full = useMemo(() => fullExtent(rowsIn.map((r, i) => getXRef.current(r, i))), [rowsIn]);
  const fullKey = full ? `${full[0]}:${full[1]}` : "";
  const zoomable = full != null && rowsIn.length >= MIN_ZOOMABLE_ROWS;
  const minSpan = full ? minSpanFor(full, rowsIn.length) : 0;

  // Mirrors for the native wheel listener and pointer handlers.
  const live = useRef({ full, win, zoomable, minSpan });
  live.current = { full, win, zoomable, minSpan };

  // A new data extent (range change, chain switch) starts from the full view.
  useEffect(() => {
    setWin(null);
    yRef.current = {};
    setYRanges({});
  }, [fullKey]);

  const zoomBy = useCallback((spanFactor: number, anchorFrac = 0.5) => {
    const { full: f, win: w, zoomable: z, minSpan: m } = live.current;
    if (!f || !z) return;
    // Written through immediately: several pointer moves can land before a render.
    const next = zoomWindow(f, w, anchorFrac, spanFactor, m);
    live.current.win = next;
    setWin(next);
  }, []);
  const panBy = useCallback((deltaFrac: number) => {
    const { full: f, win: w } = live.current;
    if (!f) return;
    const next = panWindow(f, w, deltaFrac);
    live.current.win = next;
    setWin(next);
  }, []);
  const dragY = useCallback((side: AxisSide, spanFactor: number, base: YRange) => {
    const next = scaleYRange(yRef.current[side] ?? base, spanFactor, base);
    yRef.current = { ...yRef.current, [side]: next };
    setYRanges(yRef.current);
  }, []);
  const yScale = useCallback((side: AxisSide, scale: YAxisScale) => applyYRange(scale, yRanges[side]), [yRanges]);
  const reset = useCallback(() => {
    setWin(null);
    yRef.current = {};
    setYRanges({});
  }, []);

  // Native non-passive wheel listener: React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const { win: w, zoomable: z } = live.current;
      if (!z) return;
      const rect = plotRect(node);
      if (!insideRect(e.clientX, e.clientY, rect)) return;
      // Sideways trackpad swipes pan a zoomed chart.
      if (w && !e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        panBy(Math.sign(e.deltaX) * WHEEL_PAN_FRACTION);
        return;
      }
      if (!shouldCaptureWheel(z, w != null, e.deltaY, e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomBy(wheelSpanFactor(e.deltaY, e.deltaMode), plotFraction(e.clientX, rect.left, rect.right));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [node, zoomBy, panBy]);

  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<{ id: number; lastX: number; moved: boolean } | null>(null);
  const pinch = useRef<number | null>(null);

  const pinchDistance = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!live.current.zoomable) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const frame = nodeRef.current;
    if (!frame || !insideRect(e.clientX, e.clientY, plotRect(frame))) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      drag.current = null;
      pinch.current = pinchDistance();
    } else if (pointers.current.size === 1) {
      drag.current = { id: e.pointerId, lastX: e.clientX, moved: false };
    }
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const frame = nodeRef.current;
      if (!frame || !pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const rect = plotRect(frame);
      if (pointers.current.size === 2 && pinch.current != null) {
        const next = pinchDistance();
        const [a, b] = [...pointers.current.values()];
        zoomBy(pinchSpanFactor(pinch.current, next), plotFraction((a.x + b.x) / 2, rect.left, rect.right));
        pinch.current = next;
        return;
      }
      const d = drag.current;
      if (!d || d.id !== e.pointerId || !live.current.win) return;
      if (!d.moved && Math.abs(e.clientX - d.lastX) < DRAG_THRESHOLD_PX) return;
      if (!d.moved) {
        d.moved = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      const width = rect.right - rect.left;
      if (width > 0) panBy(-(e.clientX - d.lastX) / width);
      d.lastX = e.clientX;
    },
    [zoomBy, panBy],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (drag.current?.id === e.pointerId) drag.current = null;
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const { zoomable: z, win: w } = live.current;
      if (!z || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "+" || e.key === "=") zoomBy(KEY_ZOOM_FACTOR);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / KEY_ZOOM_FACTOR);
      else if (e.key === "0" || e.key === "Escape") reset();
      else if (w && e.key === "ArrowLeft") panBy(-KEY_PAN_FRACTION);
      else if (w && e.key === "ArrowRight") panBy(KEY_PAN_FRACTION);
      else return;
      e.preventDefault();
    },
    [zoomBy, panBy, reset],
  );

  const rows = useMemo(() => sliceWindow(rowsIn, (r, i) => getXRef.current(r, i), win), [rowsIn, win]);

  const zoomed = win != null || Object.keys(yRanges).length > 0;

  return { rows, zoomable, zoomed, window: win, yRanges, reset, zoomBy, panBy, dragY, yScale, containerRef, onPointerDown, onPointerMove, onPointerUp, onKeyDown };
};
