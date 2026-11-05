import { describe, expect, it } from "vitest";
import { getProject } from "@/lib/projects";
import { hasNoStaking, stakingNoneText } from "@/lib/stakingNote";

describe("hasNoStaking", () => {
  it("is true when the project declares no staking contract or program", () => {
    expect(hasNoStaking({ chains: [{ key: "ethereum", name: "Ethereum", tokens: [] }], staking: [] })).toBe(true);
    expect(hasNoStaking({ chains: [{ key: "ethereum", name: "Ethereum", tokens: [] }] })).toBe(true);
  });

  it("is false when any chain holds a staking entry", () => {
    const staked = {
      chains: [{ key: "polygon", name: "Polygon", tokens: [] }],
      staking: [{ chain: "polygon", address: "0x1", name: "Staking" }],
    };
    expect(hasNoStaking(staked)).toBe(false);
  });

  it("follows the registered projects' configs", () => {
    expect(hasNoStaking(getProject("ondo"))).toBe(true);
    expect(hasNoStaking(getProject("tel"))).toBe(false);
    expect(hasNoStaking(getProject("zebec-network"))).toBe(false);
  });
});

describe("stakingNoneText", () => {
  it("says the token has no staking mechanism, naming the project", () => {
    const text = stakingNoneText(getProject("ondo"));
    expect(text).toContain("Ondo");
    expect(text).toMatch(/no staking/i);
  });

  it("lets a project override the wording through copy.text", () => {
    const ondo = getProject("ondo");
    const custom = { ...ondo, copy: { text: { "staking.none": "{name}: nothing to stake." } } };
    expect(stakingNoneText(custom)).toBe("Ondo: nothing to stake.");
  });
});
