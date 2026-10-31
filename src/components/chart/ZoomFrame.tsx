import { useRef, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CHART_FOCUS_RING } from "@/components/ui/chart";
import { RotateCcw } from "lucide-react";
import type { ChartZoom } from "@/hooks/useChartZoom";
import { plotRect } from "@/hooks/useChartZoom";
import { axisDragSpanFactor, isEventInside, isFrameDoubleClick, type XRange } from "@/lib/chartZoom";
import type { AxisSide } from "@/lib/chartAxes";
import { cn } from "@/lib/utils";

/** Height of the X-axis drag strip, which covers the tick-label row under the plot. */
const X_STRIP_H = "h-7";
/** Width of a Y-axis drag strip, which covers that axis's tick labels. */
const Y_STRIP_W = "w-10";

type Props<T> = {
  zoom: ChartZoom<T>;
  children: ReactNode;
  className?: string;
  /** Shown in the header row, outside the plot (e.g. AxisBaselineNote). */
  notes?: ReactNode;
  /** Y axes that get a drag strip, with each axis's auto-fit range. */
  yAxes?: Partial<Record<AxisSide, XRange>>;
};

type StripDrag = { id: number; axis: "x" | "y"; side?: AxisSide; last: number };
/** Timestamps of the frame's last two pointerdowns; a double-click needs both to land here. */
type FrameDowns = { prev: number | null; last: number | null };

/**
 * Wraps a chart with the shared zoom gestures, a header row for notes and the
 * "Reset zoom" control (only while zoomed), and drag strips along the axes.
 *
 * Gestures: pinch / wheel / drag over the plot; drag the X strip (under the plot)
 * to stretch or shrink the time range; drag a Y strip (beside the plot) to
 * stretch or shrink that axis. Dragging right or up zooms in, left or down out.
 * The plot is always `touch-action: pan-y` so a vertical swipe still scrolls the page,
 * whether or not the chart is zoomable; only the Y strip takes vertical drags.
 *
 * Keyboard: ONE Tab stop per chart, the Recharts plot (`accessibilityLayer`;
 * charts in a ZoomFrame must set it). This wrapper is tabIndex -1: a click can
 * focus it, Tab never lands on it, and it still receives the plot's key events
 * as they bubble. Key map (see `zoomKeyIntent`):
 *   Left / Right      step the data tooltip (plot) - or pan, if this frame was click-focused
 *   Shift + Left/Right pan the zoomed window (captured here, so the tooltip stays put)
 *   + / =  and  - / _  zoom in / out         0 or Escape  reset
 * "Reset zoom" and "View data as table" remain ordinary buttons.
 */
export function ZoomFrame<T>({ zoom, children, className, notes, yAxes }: Props<T>) {
  const { zoomable } = zoom;
  const drag = useRef<StripDrag | null>(null);
  const downs = useRef<FrameDowns>({ prev: null, last: null });
  const sides = Object.keys(yAxes ?? {}) as AxisSide[];

  const startDrag = (axis: "x" | "y", side?: AxisSide) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, axis, side, last: axis === "x" ? e.clientX : e.clientY };
  };

  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const frame = e.currentTarget.parentElement;
    if (!d || d.id !== e.pointerId || !frame) return;
    const rect = plotRect(frame);
    if (d.axis === "x") {
      zoom.zoomBy(axisDragSpanFactor(e.clientX - d.last, rect.width), 0.5);
      d.last = e.clientX;
      return;
    }
    const base = d.side ? yAxes?.[d.side] : undefined;
    if (d.side && base) zoom.dragY(d.side, axisDragSpanFactor(d.last - e.clientY, rect.height), base);
    d.last = e.clientY;
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const stopAndIgnore = (e: { stopPropagation: () => void }) => e.stopPropagation();

  // Shift+Arrow pans. Handled in the capture phase so the focused plot, which
  // also reads arrows, does not step its tooltip at the same time.
  const onPanKeyCapture = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    if (!zoom.zoomed) return;
    e.stopPropagation();
    zoom.onKeyDown(e);
  };

  const onFramePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    downs.current = { prev: downs.current.last, last: performance.now() };
    zoom.onPointerDown(e);
  };

  // A dblclick whose two clicks did not both land on the frame (e.g. a dialog
  // backdrop closed under the first click) must not reset the zoom.
  const onFrameDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const { prev, last } = downs.current;
    if (!isEventInside(e.currentTarget, e.target)) return;
    if (last != null && isFrameDoubleClick(prev, last)) zoom.reset();
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {(notes != null || zoom.zoomed) && (
        <div className="flex shrink-0 items-center justify-between gap-2">
          <div className="min-w-0">{notes}</div>
          {zoom.zoomed && (
            <button
              type="button"
              onClick={zoom.reset}
              className="ml-auto inline-flex h-5 max-xl:h-11 max-xl:px-3 shrink-0 items-center gap-1 rounded border border-border bg-background px-1.5 text-xs text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
              Reset zoom
            </button>
          )}
        </div>
      )}
      <div
        ref={zoom.containerRef}
        className={cn(
          "relative min-h-0 w-full flex-1 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          CHART_FOCUS_RING,
        )}
        style={{ touchAction: "pan-y" }}
        tabIndex={zoomable ? -1 : undefined}
        role={zoomable ? "group" : undefined}
        aria-label={zoomable ? "Chart. Scroll to zoom, drag to pan, plus and minus keys zoom, Escape resets." : undefined}
        onPointerDown={onFramePointerDown}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerUp}
        onDoubleClick={zoomable ? onFrameDoubleClick : undefined}
        onKeyDownCapture={onPanKeyCapture}
        onKeyDown={zoom.onKeyDown}
        data-zoomed={zoom.zoomed || undefined}
      >
        {children}
        {zoomable && (
          <div
            aria-hidden="true"
            data-testid="axis-strip-x"
            title="Drag to stretch the time range"
            className={cn("absolute inset-x-0 bottom-0 cursor-ew-resize", X_STRIP_H)}
            style={{ touchAction: "pan-y" }}
            onPointerDown={(e) => {
              stopAndIgnore(e);
              startDrag("x")(e);
            }}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={stopAndIgnore}
          />
        )}
        {zoomable && sides.map((side) => (
          <div
            key={side}
            aria-hidden="true"
            data-testid={`axis-strip-y-${side}`}
            title="Drag to stretch the value range"
            className={cn("absolute bottom-7 top-0 cursor-ns-resize", Y_STRIP_W, side === "left" ? "left-0" : "right-0")}
            style={{ touchAction: "none" }}
            onPointerDown={(e) => {
              stopAndIgnore(e);
              startDrag("y", side)(e);
            }}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={stopAndIgnore}
          />
        ))}
      </div>
    </div>
  );
}
