import { describe, expect, it } from "vitest";
import { getProject } from "@/lib/projects";
import { projectEntities } from "@/lib/projectCopy";
import { showsAssociationFlows } from "@/components/AssociationFlowAnalysis";
import { historyScope } from "./SupplyTerminal";

const scope = (slug: string, escrow: string) => {
  const project = getProject(slug);
  return historyScope(project, projectEntities(project), escrow);
};

describe("historyScope (gate / panel description)", () => {
  it("TEL reads exactly as before", () => {
    expect(scope("tel", "Escrow")).toEqual({ text: "Association Safes, Telcoin Holdings and Escrow", hasEscrow: true });
    expect(scope("tel", "escrow").text).toBe("Association Safes, Telcoin Holdings and escrow");
  });

  it("a treasury-only token claims no Safes, holdings or escrow", () => {
    for (const slug of ["zebec-network", "ondo"]) {
      const s = scope(slug, "Escrow");
      expect(s.hasEscrow).toBe(false);
      expect(s.text).not.toMatch(/Safes|Escrow|escrow/);
    }
  });

  it("an unconfigured project falls back to the entity name", () => {
    const s = historyScope({ treasury: { categories: [] } }, { associationShort: "Treasury", holdings: "Holdings" }, "Escrow");
    expect(s).toEqual({ text: "Treasury", hasEscrow: false });
  });
});

describe("showsAssociationFlows", () => {
  it("is on for TEL (council Safes) and off for the other current projects", () => {
    expect(showsAssociationFlows(getProject("tel"))).toBe(true);
    expect(showsAssociationFlows(getProject("zebec-network"))).toBe(false);
    expect(showsAssociationFlows(getProject("ondo"))).toBe(false);
  });

  it("is an explicit opt-in: a TEL-shaped stub with the flag shows, a council category alone does not", () => {
    expect(showsAssociationFlows({ gated: { forensics: true, associationFlows: true } })).toBe(true);
    const councilStub = { gated: { forensics: true }, supply: { developerHoldings: { subcategories: [{ category: "council", label: "C" }] } } };
    expect(showsAssociationFlows(councilStub)).toBe(false);
    expect(showsAssociationFlows({ gated: { associationFlows: false } })).toBe(false);
    expect(showsAssociationFlows({})).toBe(false);
  });
});
