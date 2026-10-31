import { describe, expect, it } from "vitest";
import { CANVAS_H, CANVAS_W, canvasOriginX, canvasWidthFor, WALLETS_ORIGIN_X, WALLETS_W } from "@/components/tierflow/geometry";
import { READABLE_TIER_SCALE, tierCanvasScale } from "./tierFlowScale";

const base = { canvasW: CANVAS_W, canvasH: CANVAS_H };

describe("canvasWidthFor", () => {
  it("crops Wallets and keeps the full TEL canvas", () => {
    expect(canvasWidthFor("wallets")).toBe(WALLETS_W);
    expect(canvasWidthFor("tel")).toBe(CANVAS_W);
    expect(canvasOriginX("wallets")).toBe(WALLETS_ORIGIN_X);
    expect(canvasOriginX("tel")).toBe(0);
  });
});

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

  it("minScale replaces the stacked floor", () => {
    expect(tierCanvasScale({ ...base, terminal: false, clientWidth: 700, clientHeight: 800, minScale: 0.86 })).toBe(0.86);
    expect(tierCanvasScale({ ...base, terminal: false, clientWidth: 400, clientHeight: 800 })).toBeCloseTo(400 / CANVAS_W, 3);
  });

  it("the cropped Wallets canvas is 1:1 at tablet width", () => {
    expect(tierCanvasScale({ terminal: false, clientWidth: 700, clientHeight: 800, canvasW: canvasWidthFor("wallets"), canvasH: CANVAS_H })).toBe(1);
  });

  it("stacked layout still fits the width, including below the terminal floor", () => {
    const scale = tierCanvasScale({ ...base, terminal: false, clientWidth: 400, clientHeight: 800 });
    expect(scale).toBeCloseTo(400 / CANVAS_W, 3);
    expect(scale).toBeLessThan(READABLE_TIER_SCALE);
  });
});
