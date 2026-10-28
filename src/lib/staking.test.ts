import { describe, expect, it } from "vitest";
import { combinedStaked, historyStakingPoint, v3StakedOn, v3StakingGapEvents } from "./staking";

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

  it("plots a program-only stakingV3Balance without inventing a legacy balance", () => {
    const zbcn = historyStakingPoint("2026-10-28", undefined, 4_751_393_844);
    expect(zbcn).toEqual({ staking: null, stakingV3: 4_751_393_844, stakingTotal: 4_751_393_844 });
    expect(historyStakingPoint("2026-10-28", null, null)).toBeNull();
  });

  it("keeps the TEL v3 gap as an unknown total", () => {
    const gap = historyStakingPoint("2026-09-05", 4_184_588_760, undefined);
    expect(gap?.staking).toBe(4_184_588_760);
    expect(gap?.stakingV3).toBeNull();
    expect(gap?.stakingTotal).toBeNull();
    const before = historyStakingPoint("2026-08-01", 4_184_588_760, undefined);
    expect(before?.stakingTotal).toBe(4_184_588_760);
    expect(historyStakingPoint("2026-10-23", 727e6, 2_991e6)?.stakingTotal).toBe(727e6 + 2_991e6);
  });

  it("flags only baselines inside the unmeasured window", () => {
    expect(v3StakingGapEvents("2026-01-01", undefined)).toEqual([]);
    expect(v3StakingGapEvents("2026-10-23", 1)).toEqual([]);
    expect(v3StakingGapEvents(null, undefined)).toEqual([]);
    const [e] = v3StakingGapEvents("2026-10-02", undefined);
    expect(e.affects.metrics).toContain("stakingBalance");
    expect(e.date).toBe("2026-09-01");
    expect(e.summary).toMatch(/^The staked total now includes/);
    expect(v3StakingGapEvents("2026-10-02", undefined, undefined, "TEL")[0].summary).toMatch(/^Staked TEL now includes the v3 StakingModule/);
  });
});
