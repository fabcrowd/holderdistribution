import { describe, expect, it } from "vitest";
import { findPlotRect } from "./useChartZoom";
import { plotFraction, zoomWindow } from "@/lib/chartZoom";

const rect = (top: number, bottom: number) => ({ left: 60, right: 460, top, bottom });
const TOP_PLOT = rect(10, 110);
const BOTTOM_PLOT = rect(150, 250);
const DOMAIN = [0, 1000] as const;
const MIN_SPAN = 10;

/** Pointer x over a plot becomes an anchor time through that plot's own rect. */
const windowAt = (clientX: number, plot: { left: number; right: number }) =>
  zoomWindow([...DOMAIN], null, plotFraction(clientX, plot.left, plot.right), 0.5, MIN_SPAN);

describe("findPlotRect", () => {
  const plots = [TOP_PLOT, BOTTOM_PLOT];

  it("picks the top plot for a pointer inside it", () => {
    expect(findPlotRect(plots, 200, 50)).toBe(TOP_PLOT);
  });

  it("picks the bottom plot for a pointer inside it", () => {
    expect(findPlotRect(plots, 200, 200)).toBe(BOTTOM_PLOT);
  });

  it("returns null for a pointer in the gap between plots", () => {
    expect(findPlotRect(plots, 200, 130)).toBeNull();
  });

  it("returns null for a pointer outside the plots horizontally", () => {
    expect(findPlotRect(plots, 10, 200)).toBeNull();
  });

  it("returns null when there are no plot rects", () => {
    expect(findPlotRect([], 200, 200)).toBeNull();
  });
});

describe("stacked plots share one x mapping", () => {
  it("maps the same pointer x to the same time window on both plots", () => {
    const top = windowAt(260, TOP_PLOT);
    const bottom = windowAt(260, BOTTOM_PLOT);
    expect(top).not.toBeNull();
    expect(bottom).toEqual(top);
  });

  it("anchors the zoom at the pointer's time, not the plot's own top edge", () => {
    const left = windowAt(60, BOTTOM_PLOT);
    const right = windowAt(460, BOTTOM_PLOT);
    expect(left?.[0]).toBe(DOMAIN[0]);
    expect(right?.[1]).toBe(DOMAIN[1]);
  });
});
