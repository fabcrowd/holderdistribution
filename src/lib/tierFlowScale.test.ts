import { describe, expect, it } from "vitest";
import { CANVAS_H, CANVAS_W } from "@/components/tierflow/geometry";
import { READABLE_TIER_SCALE, tierCanvasScale } from "./tierFlowScale";

const base = { canvasW: CANVAS_W, canvasH: CANVAS_H };

describe("tierCanvasScale", () => {
  it("terminal fits width and never shrinks labels below the readable floor", () => {
    // Old 7-column cell at 1280: ~730px wide, ~580px tall → ~0.78 by width
    // and worse once height was also fitted. Floor holds the type.
    const narrow = tierCanvasScale({ ...base, terminal: true, clientWidth: 730, clientHeight: 420 });
    expect(narrow).toBe(READABLE_TIER_SCALE);
    expect(narrow).toBeGreaterThan(730 / CANVAS_W);
  });

  it("terminal does not shrink to fit height when the width already fits", () => {
    const wideShort = tierCanvasScale({ ...base, terminal: true, clientWidth: 1400, clientHeight: 400 });
    expect(wideShort).toBe(1);
    expect(400 / CANVAS_H).toBeLessThan(READABLE_TIER_SCALE);
  });

  it("terminal scales down gently between the floor and 1", () => {
    const width = Math.round(CANVAS_W * 0.96);
    expect(tierCanvasScale({ ...base, terminal: true, clientWidth: width, clientHeight: 2000 })).toBeCloseTo(0.96, 2);
  });

  it("stacked layout still fits the width, including below the terminal floor", () => {
    const scale = tierCanvasScale({ ...base, terminal: false, clientWidth: 400, clientHeight: 800 });
    expect(scale).toBeCloseTo(400 / CANVAS_W, 3);
    expect(scale).toBeLessThan(READABLE_TIER_SCALE);
  });
});
