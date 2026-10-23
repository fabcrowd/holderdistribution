import { describe, expect, it } from "vitest";
import { Area, Bar, Line, Pie } from "recharts";
import { setRechartsAnimation } from "./rechartsMotion";

type D = { defaultProps: { isAnimationActive?: boolean } };

describe("recharts default animation follows reduced motion", () => {
  it("turns every series default off and back on", () => {
    setRechartsAnimation(false);
    for (const c of [Area, Bar, Line, Pie] as unknown as D[]) expect(c.defaultProps.isAnimationActive).toBe(false);
    setRechartsAnimation(true);
    for (const c of [Area, Bar, Line, Pie] as unknown as D[]) expect(c.defaultProps.isAnimationActive).toBe(true);
  });
});
