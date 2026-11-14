import { describe, expect, it } from "vitest";
import { circulatingDefinition, subtractTerms } from "./circulatingSubtract";
import { circulatingFormula } from "./supplyBreakdown";

describe("circulating copy generated from the subtract list", () => {
  it("collapses treasury + council into the association label", () => {
    expect(subtractTerms(["treasury", "council"], "Safes")).toEqual(["Safes"]);
    expect(circulatingDefinition(["treasury", "council"], "Safes", ["treasury", "council", "escrow"])).toBe(
      "Circulating = counted supply − Safes, less any wallet-level non-circulating override (committed escrow).",
    );
  });
  it("omits escrow wording for projects without an escrow category", () => {
    expect(circulatingDefinition(["treasury", "holdings", "team"], "Zebec Treasury", ["treasury", "holdings", "team", "staking"])).toBe(
      "Circulating = counted supply − Zebec Treasury − Holdings − Team wallets, less any wallet-level non-circulating override.",
    );
    expect(circulatingDefinition(["treasury", "holdings"], "Ondo")).not.toMatch(/escrow/i);
  });
  it("names only subtract terms the feed holds a balance in", () => {
    const subtract = ["treasury", "holdings", "team"];
    const noTeam = { treasury: 10, holdings: 5, team: 0 };
    const withTeam = { treasury: 10, holdings: 5, team: 3 };
    const noTeamText = circulatingDefinition(subtract, "Ondo", [], noTeam);
    expect(noTeamText).toBe(
      "Circulating = counted supply − Ondo − Holdings, less any wallet-level non-circulating override.",
    );
    expect(noTeamText).not.toMatch(/team/i);
    expect(circulatingDefinition(subtract, "Ondo", [], { treasury: 10, holdings: 5 })).toBe(noTeamText);
    expect(circulatingDefinition(subtract, "Ondo", [], withTeam)).toContain("− Holdings − Team wallets");
  });
  it("reads as plain counted supply when no subtract term has a balance", () => {
    expect(circulatingDefinition(["treasury", "holdings", "team"], "Ondo", [], { retail: 9 })).toBe(
      "Circulating = counted supply, less any wallet-level non-circulating override.",
    );
    expect(circulatingDefinition(["treasury", "team"], "Ondo", [], {})).toBe(
      "Circulating = counted supply, less any wallet-level non-circulating override.",
    );
  });
  it("keeps the TEL-shaped definition unchanged", () => {
    const tel = { treasury: 100, council: 50, escrow: 20 };
    expect(circulatingDefinition(["treasury", "council"], "Safes", ["treasury", "council", "escrow"], tel)).toBe(
      "Circulating = counted supply − Safes, less any wallet-level non-circulating override (committed escrow).",
    );
  });
  it("lists exactly the configured categories", () => {
    expect(circulatingDefinition(["treasury"], "Zebec Treasury")).toContain("− Zebec Treasury,");
    expect(circulatingDefinition(["treasury", "holdings"], "T")).toContain("− T − Holdings");
    expect(circulatingDefinition([], "T")).toMatch(/^Circulating = counted supply,/);
  });
  it("formula follows the list and ignores empty categories", () => {
    const cats = { treasury: 5, holdings: 7 };
    expect(circulatingFormula(cats, { association: "T" }, 0, ["treasury"])).toBe("counted − T");
    expect(circulatingFormula(cats, { association: "T" }, 0, ["treasury", "holdings"])).toBe("counted − T − Holdings");
    expect(circulatingFormula(cats, { association: "T" }, 0, [])).toBe("counted");
  });
});
