import { describe, expect, it } from "vitest";
import {
  CHART_HEIGHT,
  CHART_HEIGHT_CLASS,
  CHART_TICK,
  GRID_GAP_PX,
  MIN_FONT_PX,
  PANEL_PADDING_PX,
  SECTION_GAP_PX,
  SPACE_PX,
  TYPE_PX,
} from "./terminalLayout";

describe("terminal layout tokens", () => {
  it("defines the chart height tiers", () => {
    expect(CHART_HEIGHT.hero).toBe("clamp(420px, 55dvh, 560px)");
    expect(CHART_HEIGHT.standard).toBe("300px");
    expect(CHART_HEIGHT.compact).toBe("200px");
  });

  it("keeps the Tailwind tier classes in step with the tiers", () => {
    expect(CHART_HEIGHT_CLASS.hero).toBe(`h-[${CHART_HEIGHT.hero.replace(/, /g, ",")}]`);
    expect(CHART_HEIGHT_CLASS.standard).toBe(`h-[${CHART_HEIGHT.standard}]`);
    expect(CHART_HEIGHT_CLASS.compact).toBe(`h-[${CHART_HEIGHT.compact}]`);
  });

  it("spacing uses only the 8/12/16/24 scale", () => {
    const scale = Object.values(SPACE_PX);
    expect(scale).toEqual([8, 12, 16, 24]);
    expect([PANEL_PADDING_PX, GRID_GAP_PX, SECTION_GAP_PX]).toEqual([12, 12, 24]);
  });

  it("nothing in the type scale used on charts is below 12px", () => {
    expect(TYPE_PX.axisTick).toBeGreaterThanOrEqual(MIN_FONT_PX);
    expect(TYPE_PX.caption).toBeGreaterThanOrEqual(MIN_FONT_PX);
    expect(CHART_TICK.fontSize).toBe(12);
  });
});
