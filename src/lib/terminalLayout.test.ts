import { describe, expect, it } from "vitest";
import {
  HOLDERS_PRIMARY_ROW_HEIGHT,
  PRIMARY_ROW_MAX_PX,
  PRIMARY_ROW_MIN_PX,
  chartBodyPx,
  holdersPrimaryRowPx,
  legacyChartBodyPx,
} from "./terminalLayout";

describe("holders terminal chart height", () => {
  it("the old 2×7 grid left a 296px chart body at 1280×800", () => {
    expect(legacyChartBodyPx(800)).toBe(296);
  });

  it("the primary row is meaningfully taller at laptop and desktop heights", () => {
    for (const viewport of [720, 800, 900, 1080]) {
      const row = holdersPrimaryRowPx(viewport);
      const body = chartBodyPx(row);
      expect(row).toBeGreaterThanOrEqual(PRIMARY_ROW_MIN_PX);
      expect(row).toBeLessThanOrEqual(PRIMARY_ROW_MAX_PX);
      expect(body).toBeGreaterThan(legacyChartBodyPx(800));
    }
    // 800px: just under the cap (568px row, body 516) — well clear of 296.
    expect(holdersPrimaryRowPx(800)).toBe(568);
    expect(chartBodyPx(holdersPrimaryRowPx(800))).toBe(516);
    // 900px and up sit on the cap.
    expect(holdersPrimaryRowPx(900)).toBe(PRIMARY_ROW_MAX_PX);
    // Short laptop still clears the old body, using the floor rather than 296.
    expect(holdersPrimaryRowPx(680)).toBe(PRIMARY_ROW_MIN_PX);
    expect(chartBodyPx(PRIMARY_ROW_MIN_PX)).toBeGreaterThan(380);
  });

  it("the CSS height is the same clamp the helper computes", () => {
    expect(HOLDERS_PRIMARY_ROW_HEIGHT).toBe(
      `clamp(${PRIMARY_ROW_MIN_PX}px, calc(100dvh - 232px), ${PRIMARY_ROW_MAX_PX}px)`,
    );
  });
});
