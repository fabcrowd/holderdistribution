import { describe, expect, it } from "vitest";
import { focusTierTile, tierTileSelector } from "./focusTier";

describe("tierTileSelector", () => {
  it("targets the tier tile inside the diagram, not the Tiers table row", () => {
    expect(tierTileSelector("25M-50M")).toContain('[data-testid="tier-flow"]');
    expect(tierTileSelector("25M-50M")).toContain('[data-tier="25M-50M"]');
  });
  it("escapes quotes so a label cannot break out of the attribute", () => {
    expect(tierTileSelector('a"b')).not.toContain('"a"b"');
  });
});

describe("focusTierTile", () => {
  it("does nothing without a label", () => {
    expect(focusTierTile(null)).toBe(false);
    expect(focusTierTile(undefined)).toBe(false);
  });
  it("focuses the matching tile and reports it", () => {
    let focused = 0;
    const doc = { querySelector: (sel: string) => (sel.includes('"X"') ? { focus: () => { focused += 1; } } : null) } as unknown as Document;
    expect(focusTierTile("X", doc)).toBe(true);
    expect(focused).toBe(1);
    expect(focusTierTile("Y", doc)).toBe(false);
  });
});
