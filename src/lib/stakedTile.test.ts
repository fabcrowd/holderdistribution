import { describe, expect, it } from "vitest";
import { PROJECTS, getProject } from "./projects";
import { chainViewKeys, stakedScope, stakingChainKeys } from "./chainViews";
import { stakedTileCopy } from "./stakedTile";

describe("stakedScope across every registered project", () => {
  it.each(PROJECTS.map((p) => [p.slug]))("%s: a view is measured, or points at the staking chain", (slug) => {
    const project = getProject(slug);
    const stakingKeys = stakingChainKeys(project);
    const stakingNames = project.chains.filter((c) => stakingKeys.includes(c.key)).map((c) => c.name);
    for (const view of chainViewKeys(project)) {
      const scope = stakedScope(project, view);
      if (stakingKeys.length === 0) {
        expect(scope).toEqual({ kind: "none" });
      } else if (view === "combined" || stakingKeys.includes(view)) {
        expect(scope).toEqual({ kind: "view" });
      } else {
        expect(scope.kind).toBe("projectWide");
        if (scope.kind === "projectWide") {
          for (const name of stakingNames) expect(scope.where).toContain(name);
        }
      }
    }
  });

  it("ZBCN: Solana is the only chain and holds the staking, so every view is measured", () => {
    const zbcn = getProject("zebec-network");
    expect(chainViewKeys(zbcn)).toEqual(["combined", "solana"]);
    expect(stakedScope(zbcn, "combined")).toEqual({ kind: "view" });
    expect(stakedScope(zbcn, "solana")).toEqual({ kind: "view" });
  });

  it("a project without staking gets no Staked tile on any view", () => {
    const tel = getProject("tel");
    const noStaking = { ...tel, staking: [] };
    for (const view of chainViewKeys(noStaking)) {
      expect(stakedScope(noStaking, view)).toEqual({ kind: "none" });
    }
  });

  it("staking entries on chains the project does not have are ignored", () => {
    const tel = getProject("tel");
    const ghost = { ...tel, staking: [{ chain: "solana", address: "x", name: "ghost" }] };
    expect(stakingChainKeys(ghost)).toEqual([]);
    expect(stakedScope(ghost, "ethereum")).toEqual({ kind: "none" });
  });
});

describe("stakedTileCopy", () => {
  it("project-wide figure names the chain it lives on and its share of supply", () => {
    expect(
      stakedTileCopy({ ticker: "TEL", projectWideWhere: "Polygon", staked: 25, retailBalance: 100, totalSupply: 1000 }),
    ).toEqual({
      sub: "On Polygon · 2.50% of supply",
      tooltip: "Staked TEL is held on Polygon. 25.00% of retail TEL balance.",
    });
  });

  it("view figure shows share of retail and of supply", () => {
    expect(stakedTileCopy({ ticker: "ZBCN", projectWideWhere: null, staked: 25, retailBalance: 100, totalSupply: 1000 })).toEqual({
      sub: "25.00% of retail · 2.50% of supply",
      tooltip: "25.00% of retail ZBCN balance.",
    });
  });

  it("omits a share whose denominator is unknown or zero", () => {
    expect(stakedTileCopy({ ticker: "TEL", projectWideWhere: null, staked: 25, retailBalance: null, totalSupply: 0 })).toEqual({
      sub: "",
      tooltip: "",
    });
  });
});
