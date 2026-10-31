import { describe, expect, it } from "vitest";
import { ALL_CHAIN_CROSSINGS_NOTE, netByTierRows } from "./netByTier";

const cause = { inTotal: 0, total: 0 } as never;

describe("netByTierRows", () => {
  const fields = [
    { label: "1-10", addedCount: 20, removedCount: 25, cause },
    { label: "10+", addedCount: 4, removedCount: 1, cause },
  ];
  it("is joined minus left per tier, in tier order", () => {
    expect(netByTierRows(fields, true).map((r) => [r.label, r.value])).toEqual([["1-10", -5], ["10+", 3]]);
  });
  it("marks every bar absent when the crossings feed is missing", () => {
    expect(netByTierRows(fields, false).every((r) => !r.has)).toBe(true);
    expect(netByTierRows(fields, true).every((r) => r.has)).toBe(true);
  });
  it("carries a one-line all-chains note", () => {
    expect(ALL_CHAIN_CROSSINGS_NOTE).toContain("all chains combined");
    expect(ALL_CHAIN_CROSSINGS_NOTE).not.toContain("\n");
  });
});
