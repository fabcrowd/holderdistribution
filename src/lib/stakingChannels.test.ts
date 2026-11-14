import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "./projects";
import {
  hasStakingGenerations,
  stakingDeployDate,
  stakingSplitText,
  stakingWording,
  v3ChannelValue,
  V3_STAKING_DEPLOY_DATE,
} from "./staking";

// Stubs only; no live feed numbers.
const stub = (staking: ProjectConfig["staking"], copy?: ProjectConfig["copy"]) =>
  ({ ticker: "AAA", name: "Aaa", chains: [], supply: {}, staking, copy }) as unknown as ProjectConfig;

const generationsProject = stub([
  { chain: "x", address: "0x1", name: "old", token: "legacy" },
  { chain: "x", address: "0x2", name: "new", token: "v3" },
]);
const programProject = stub([{ chain: "sol", address: "S1", name: "program", kind: "program" }]);
const noStakingProject = stub(undefined);

describe("hasStakingGenerations", () => {
  it("is true only when both a legacy and a v3 entry exist", () => {
    expect(hasStakingGenerations(generationsProject)).toBe(true);
    expect(hasStakingGenerations(programProject)).toBe(false);
    expect(hasStakingGenerations(noStakingProject)).toBe(false);
  });
});

describe("stakingDeployDate", () => {
  it("prefers the feed date", () => {
    expect(stakingDeployDate("2027-01-05", generationsProject)).toBe("2027-01-05");
    expect(stakingDeployDate("2027-01-05", programProject)).toBe("2027-01-05");
  });
  it("falls back to the constant only for a legacy+v3 project", () => {
    expect(stakingDeployDate(null, generationsProject)).toBe(V3_STAKING_DEPLOY_DATE);
    expect(stakingDeployDate(undefined, generationsProject)).toBe(V3_STAKING_DEPLOY_DATE);
  });
  it("is null for a program-only or no-staking project", () => {
    expect(stakingDeployDate(null, programProject)).toBeNull();
    expect(stakingDeployDate(undefined, noStakingProject)).toBeNull();
  });
});

describe("v3ChannelValue", () => {
  const deploy = Date.parse("2026-09-01");
  const before = Date.parse("2026-08-01");
  it("drops pre-deploy values when a deploy date is known (legacy+v3 project)", () => {
    expect(v3ChannelValue(deploy, before, 500)).toBeNull();
    expect(v3ChannelValue(deploy, deploy, 500)).toBe(500);
  });
  it("keeps pre-2026-09-01 data for a program-only token (no deploy date)", () => {
    const programDeploy = stakingDeployDate(null, programProject);
    const ms = programDeploy ? Date.parse(programDeploy) : null;
    expect(v3ChannelValue(ms, before, 500)).toBe(500);
    expect(v3ChannelValue(ms, before, null)).toBeNull();
  });
});

describe("stakingWording", () => {
  it("keeps the v3/legacy wording for a legacy+v3 project", () => {
    const w = stakingWording(generationsProject);
    expect(w).toMatchObject({ legacy: "Legacy contract", v3: "v3 StakingModule", legacyShort: "Legacy", v3Short: "v3", marker: "v3 migration" });
    expect(w.markerNote).toBe("The v3 StakingModule went live and stakers began migrating from the legacy contract");
    expect(stakingSplitText(w, "1M", "2M")).toBe("Legacy 1M / v3 2M");
  });
  it("lets a project's copy.text override the labels", () => {
    const w = stakingWording(
      stub(generationsProject.staking, { text: { "staking.legacyLabel": "Old pool", "staking.migrationMarker": "Pool move" } } as ProjectConfig["copy"]),
    );
    expect(w.legacy).toBe("Old pool");
    expect(w.marker).toBe("Pool move");
    expect(w.v3).toBe("v3 StakingModule");
  });
});
