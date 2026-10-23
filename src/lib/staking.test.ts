import { describe, expect, it } from "vitest";
import { combinedStaked, v3StakedOn, v3StakingGapEvents } from "./staking";

describe("staking (legacy + v3)", () => {
  it("v3 is 0 before the deploy, unknown in the gap, measured when recorded", () => {
    expect(v3StakedOn("2026-08-31", undefined)).toBe(0);
    expect(v3StakedOn("2026-01-01T00:00:00Z", null)).toBe(0);
    expect(v3StakedOn("2026-09-01", undefined)).toBeNull();
    expect(v3StakedOn("2026-10-02", undefined)).toBeNull();
    expect(v3StakedOn("2026-10-23", 2_991_605_170)).toBe(2_991_605_170);
    expect(v3StakedOn(Date.parse("2026-08-15"), null)).toBe(0);
  });

  it("combines only when both sides are known", () => {
    expect(combinedStaked(727e6, 2_991e6)).toBe(3_718e6);
    expect(combinedStaked(3_980e6, 0)).toBe(3_980e6);
    expect(combinedStaked(727e6, null)).toBeNull();
    expect(combinedStaked(null, 0)).toBeNull();
  });

  it("flags only baselines inside the unmeasured window", () => {
    expect(v3StakingGapEvents("2026-01-01", undefined)).toEqual([]);
    expect(v3StakingGapEvents("2026-10-23", 1)).toEqual([]);
    expect(v3StakingGapEvents(null, undefined)).toEqual([]);
    const [e] = v3StakingGapEvents("2026-10-02", undefined);
    expect(e.affects.metrics).toContain("stakingBalance");
    expect(e.date).toBe("2026-09-01");
  });
});
