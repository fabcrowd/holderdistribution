import { describe, expect, it } from "vitest";
import { stakingSplitSub } from "./stakingSplit";

const fmt = (n: number) => String(n);

describe("stakingSplitSub", () => {
  it("shows Legacy / v3 only when both channels have stakers (TEL)", () => {
    const both = { legacy: { stakerCount: 3, stakedTotal: 30 }, v3: { stakerCount: 2, stakedTotal: 20 } };
    expect(stakingSplitSub(both, "count", fmt)).toBe("Legacy 3 / v3 2");
    expect(stakingSplitSub(both, "total", fmt)).toBe("Legacy 30 / v3 20");
  });

  it("hides the split for a single-program project (ZBCN: legacy empty)", () => {
    expect(stakingSplitSub({ legacy: { stakerCount: 0, stakedTotal: 0 }, v3: { stakerCount: 5, stakedTotal: 9 } }, "count", fmt)).toBeUndefined();
    expect(stakingSplitSub({ legacy: { stakerCount: 3, stakedTotal: 30 } }, "total", fmt)).toBeUndefined();
  });
});
