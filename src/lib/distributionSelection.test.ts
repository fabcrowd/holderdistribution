import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, hasSelection, reduceSelection, shouldClearOnEscape, type DistSelection } from "./distributionSelection";

const run = (...actions: Parameters<typeof reduceSelection>[1][]) =>
  actions.reduce<DistSelection>((s, a) => reduceSelection(s, a), EMPTY_SELECTION);

describe("distribution selection", () => {
  it("toggles a tier from the diagram and clears any side pivot", () => {
    expect(run({ type: "tier", label: "1M-5M" }).tier).toBe("1M-5M");
    expect(run({ type: "tier", label: "1M-5M" }, { type: "tier", label: "1M-5M" }).tier).toBeNull();
    const s = run({ type: "side", tile: { side: "in", key: "dex" } }, { type: "tier", label: "1-250K" });
    expect(s).toEqual({ tier: "1-250K", sideTile: null, expandedFlow: null });
  });

  it("table/bar selection sets (does not toggle off) the tier", () => {
    const s = run({ type: "tier-set", label: "5M-10M" }, { type: "tier-set", label: "5M-10M" });
    expect(s.tier).toBe("5M-10M");
  });

  it("a side tile with no tier is an exclusive pivot that toggles", () => {
    const tile = { side: "out" as const, key: "cex" as const };
    expect(run({ type: "side", tile })).toEqual({ tier: null, sideTile: tile, expandedFlow: null });
    expect(run({ type: "side", tile }, { type: "side", tile }).sideTile).toBeNull();
    // DEX/CEX tiles clear a selected tier.
    expect(run({ type: "tier", label: "1M-5M" }, { type: "side", tile }).tier).toBeNull();
  });

  it("keeps the tier for the 2-step wallet drill", () => {
    const tile = { side: "out" as const, key: "wallet" as const };
    const s = run({ type: "tier", label: "1M-5M" }, { type: "side", tile });
    expect(s).toEqual({ tier: "1M-5M", sideTile: tile, expandedFlow: "wallet" });
    expect(reduceSelection(s, { type: "side", tile })).toEqual({ tier: "1M-5M", sideTile: null, expandedFlow: null });
  });

  it("clear and reset-mode", () => {
    const s = run({ type: "tier", label: "1M-5M" }, { type: "flow", key: "250K-1M" });
    expect(s.expandedFlow).toBe("250K-1M");
    expect(reduceSelection(s, { type: "reset-mode" })).toEqual({ tier: "1M-5M", sideTile: null, expandedFlow: null });
    expect(reduceSelection(s, { type: "clear" })).toEqual(EMPTY_SELECTION);
    expect(reduceSelection(EMPTY_SELECTION, { type: "clear" })).toBe(EMPTY_SELECTION);
    expect(hasSelection(EMPTY_SELECTION)).toBe(false);
  });
});

describe("Escape handling", () => {
  const none = { querySelector: () => null };
  it("clears on a plain Escape", () => {
    expect(shouldClearOnEscape({ key: "Escape", target: { tagName: "BUTTON" } }, none)).toBe(true);
  });
  it("ignores other keys, handled events and text fields", () => {
    expect(shouldClearOnEscape({ key: "Enter" }, none)).toBe(false);
    expect(shouldClearOnEscape({ key: "Escape", defaultPrevented: true }, none)).toBe(false);
    expect(shouldClearOnEscape({ key: "Escape", target: { tagName: "input" } }, none)).toBe(false);
  });
  it("lets an open popover / dialog close first", () => {
    expect(shouldClearOnEscape({ key: "Escape" }, { querySelector: () => ({}) })).toBe(false);
  });
});
