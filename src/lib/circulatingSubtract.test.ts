import { describe, expect, it } from "vitest";
import { circulatingDefinition, subtractTerms } from "./circulatingSubtract";
import { circulatingFormula } from "./supplyBreakdown";

describe("circulating copy generated from the subtract list", () => {
  it("collapses treasury + council into the association label", () => {
    expect(subtractTerms(["treasury", "council"], "Safes")).toEqual(["Safes"]);
    expect(circulatingDefinition(["treasury", "council"], "Safes")).toBe(
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
