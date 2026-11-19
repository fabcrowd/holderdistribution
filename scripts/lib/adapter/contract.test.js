import { describe, expect, it } from "vitest";
import { assertCursor, compareCursors, isCursor, makeCursor, POSITION_FUNCTIONS, REQUIRED_FUNCTIONS, sameCursor, validateAdapter } from "./contract.js";
import { createSyntheticAdapter } from "./synthetic.js";

const valid = () => createSyntheticAdapter({ accounts: 10, days: 2 });
const without = (member) => {
  const { [member]: _gone, ...rest } = valid();
  return rest;
};
const withCapability = (name, value) => {
  const a = valid();
  return { ...a, capabilities: { ...a.capabilities, [name]: value } };
};

describe("validateAdapter", () => {
  it("accepts a complete adapter and returns it", () => {
    const a = valid();
    expect(validateAdapter(a)).toBe(a);
  });

  it("names every missing function", () => {
    for (const name of [...REQUIRED_FUNCTIONS, ...POSITION_FUNCTIONS]) {
      expect(() => validateAdapter(without(name)), name).toThrow(new RegExp(`adapter\\.${name} must be a function, got undefined`));
    }
  });

  it("needs the position functions only when it declares position kinds", () => {
    const { positionChanges: _a, positionsFull: _b, ...rest } = createSyntheticAdapter({ stakeShare: 0 });
    expect(rest.positionKinds).toEqual([]);
    expect(() => validateAdapter(rest)).not.toThrow();
  });

  it("names a mistyped function", () => {
    expect(() => validateAdapter({ ...valid(), discover: "later" })).toThrow(/adapter\.discover must be a function, got string later/);
  });

  it("names a missing or mistyped family, capability, or position kind list", () => {
    expect(() => validateAdapter({ ...valid(), family: "" })).toThrow(/adapter\.family/);
    expect(() => validateAdapter(without("family"))).toThrow(/adapter\.family must be a non-empty string, got undefined/);
    expect(() => validateAdapter(without("capabilities"))).toThrow(/adapter\.capabilities must be an object/);
    expect(() => validateAdapter({ ...valid(), positionKinds: "stake" })).toThrow(/adapter\.positionKinds/);
    expect(() => validateAdapter({ ...valid(), positionKinds: [""] })).toThrow(/adapter\.positionKinds/);
  });

  it("names the capability that is missing or of the wrong type", () => {
    for (const name of ["pastReadable", "listsTransfers", "balanceMovesWithoutRecord"]) {
      expect(() => validateAdapter(withCapability(name, "yes")), name).toThrow(new RegExp(`adapter\\.capabilities\\.${name} must be a boolean, got string yes`));
      expect(() => validateAdapter(withCapability(name, undefined)), name).toThrow(new RegExp(`adapter\\.capabilities\\.${name}`));
    }
    expect(() => validateAdapter(withCapability("changeSource", "guess"))).toThrow(/adapter\.capabilities\.changeSource must be one of asset-records, ledger-state, none, got string guess/);
    for (const bad of [0, -1, 1.5, "10", undefined]) expect(() => validateAdapter(withCapability("maxPageRows", bad))).toThrow(/adapter\.capabilities\.maxPageRows must be a positive integer/);
    expect(() => validateAdapter(withCapability("sortedPages", "yes"))).toThrow(/adapter\.capabilities\.sortedPages must be a boolean when present/);
    expect(() => validateAdapter(withCapability("sortedPages", undefined))).not.toThrow();
    expect(() => validateAdapter(withCapability("sortedChanges", "yes"))).toThrow(/adapter\.capabilities\.sortedChanges must be a boolean when present/);
    expect(() => validateAdapter(withCapability("sortedChanges", undefined))).not.toThrow();
    expect(() => validateAdapter(withCapability("sortedChanges", true))).not.toThrow();
  });

  it("rejects something that is not an object", () => {
    for (const bad of [null, undefined, 7, "adapter"]) expect(() => validateAdapter(bad)).toThrow(/adapter must be an object/);
  });
});

describe("cursor helpers", () => {
  it("builds a frozen cursor and recognizes one", () => {
    const c = makeCursor(4, "abc");
    expect(c).toEqual({ height: 4, id: "abc" });
    expect(Object.isFrozen(c)).toBe(true);
    expect(isCursor(c)).toBe(true);
  });

  it("refuses a cursor without a usable height or id", () => {
    expect(() => makeCursor(-1, "a")).toThrow(/cursor\.height/);
    expect(() => makeCursor(1.5, "a")).toThrow(/cursor\.height/);
    expect(() => makeCursor(1, "")).toThrow(/cursor\.id/);
    for (const bad of [null, {}, { height: 1 }, { height: 1, id: "" }, { height: "1", id: "a" }]) expect(isCursor(bad)).toBe(false);
    expect(() => assertCursor({ height: 1 }, "from")).toThrow(/from must be/);
  });

  it("orders by height and tells a reorganized block apart by its id", () => {
    expect(compareCursors(makeCursor(2, "a"), makeCursor(5, "b"))).toBeLessThan(0);
    expect(sameCursor(makeCursor(2, "a"), makeCursor(2, "a"))).toBe(true);
    expect(sameCursor(makeCursor(2, "a"), makeCursor(2, "other"))).toBe(false);
  });
});
