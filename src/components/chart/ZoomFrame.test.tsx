import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChartZoom } from "@/hooks/useChartZoom";
import { ZoomFrame } from "./ZoomFrame";
import { AxisBaselineNote } from "./AxisBaselineNote";

const zoomFake = (over: Partial<ChartZoom<unknown>>): ChartZoom<unknown> =>
  ({
    rows: [],
    zoomable: true,
    zoomed: false,
    window: null,
    yRanges: {},
    reset: () => {},
    zoomBy: () => {},
    panBy: () => {},
    dragY: () => {},
    yScale: (_side, scale) => scale,
    containerRef: () => {},
    onPointerDown: () => {},
    onPointerMove: () => {},
    onPointerUp: () => {},
    onKeyDown: () => {},
    ...over,
  }) as ChartZoom<unknown>;

describe("ZoomFrame", () => {
  it("shows the reset control only while zoomed", () => {
    expect(renderToStaticMarkup(<ZoomFrame zoom={zoomFake({})}>plot</ZoomFrame>)).not.toContain("Reset zoom");
    expect(renderToStaticMarkup(<ZoomFrame zoom={zoomFake({ zoomed: true })}>plot</ZoomFrame>)).toContain("Reset zoom");
  });

  it("renders the notes in the header, before the plot children", () => {
    const html = renderToStaticMarkup(
      <ZoomFrame zoom={zoomFake({})} notes={<AxisBaselineNote baseline={98000} format={(n) => `${n}`} />}>
        <span data-testid="plot" />
      </ZoomFrame>,
    );
    expect(html.indexOf("Axis starts at 98000")).toBeLessThan(html.indexOf('data-testid="plot"'));
  });

  it("adds an X strip when zoomable and one Y strip per requested axis", () => {
    const html = renderToStaticMarkup(<ZoomFrame zoom={zoomFake({})} yAxes={{ left: [0, 10] }}>plot</ZoomFrame>);
    expect(html).toContain('data-testid="axis-strip-x"');
    expect(html).toContain('data-testid="axis-strip-y-left"');
    expect(html).not.toContain('data-testid="axis-strip-y-right"');
  });

  it("adds no strips for a chart too short to zoom", () => {
    const html = renderToStaticMarkup(<ZoomFrame zoom={zoomFake({ zoomable: false })}>plot</ZoomFrame>);
    expect(html).not.toContain("axis-strip-x");
  });

  it("keeps the vertical Y strip out of page-scroll reach and leaves the plot pan-y", () => {
    const html = renderToStaticMarkup(<ZoomFrame zoom={zoomFake({})} yAxes={{ left: [0, 10] }}>plot</ZoomFrame>);
    expect(html).toContain("touch-action:none");
    expect(html).toContain("touch-action:pan-y");
  });
});
