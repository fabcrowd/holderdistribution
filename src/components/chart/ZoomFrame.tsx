import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { ChartZoom } from "@/hooks/useChartZoom";
import { cn } from "@/lib/utils";

type Props<T> = {
  zoom: ChartZoom<T>;
  children: ReactNode;
  className?: string;
};

/**
 * Wraps a chart with the shared zoom gestures and a "Reset zoom" control.
 * `touch-action: pan-y` keeps vertical swipes scrolling the page while
 * pinch and horizontal drags reach the chart.
 */
export function ZoomFrame<T>({ zoom, children, className }: Props<T>) {
  const { zoomable } = zoom;
  return (
    <div
      ref={zoom.containerRef}
      className={cn(
        "relative rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        zoom.zoomed && "cursor-grab active:cursor-grabbing",
        className,
      )}
      style={zoomable ? { touchAction: "pan-y" } : undefined}
      tabIndex={zoomable ? 0 : undefined}
      role={zoomable ? "group" : undefined}
      aria-label={zoomable ? "Chart. Scroll to zoom, drag to pan, plus and minus keys zoom, Escape resets." : undefined}
      onPointerDown={zoom.onPointerDown}
      onPointerMove={zoom.onPointerMove}
      onPointerUp={zoom.onPointerUp}
      onPointerCancel={zoom.onPointerUp}
      onDoubleClick={zoomable ? zoom.reset : undefined}
      onKeyDown={zoom.onKeyDown}
      data-zoomed={zoom.zoomed || undefined}
    >
      {children}
      {zoom.zoomed && (
        <button
          type="button"
          onClick={zoom.reset}
          className="absolute right-2 top-1 z-10 inline-flex items-center gap-1 rounded border border-border bg-background/90 px-2 py-0.5 text-xs text-foreground shadow-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Reset zoom
        </button>
      )}
    </div>
  );
}
