import { describe, expect, it } from "vitest";
import { GLOSSARY, glossaryTerm } from "./glossary";

describe("glossary", () => {
  it("has unique ids and non-empty plain-language definitions", () => {
    const ids = GLOSSARY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of GLOSSARY) {
      expect(t.term.length).toBeGreaterThan(1);
      expect(t.definition.length).toBeGreaterThan(40);
    }
  });
  it("covers the terms a newcomer hits first", () => {
    for (const id of ["retail", "legacy-v3", "cex", "dex", "escrow", "staked"]) expect(glossaryTerm(id)).toBeDefined();
  });
});
