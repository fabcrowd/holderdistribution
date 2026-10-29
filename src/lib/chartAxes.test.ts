import { describe, expect, it } from "vitest";
import { assignAxes, hasRightAxis, keysOnAxis } from "./chartAxes";

describe("assignAxes", () => {
  it("puts everything on the left by default", () => {
    expect(assignAxes([{ key: "a" }, { key: "b" }])).toEqual({ a: "left", b: "left" });
    expect(hasRightAxis([{ key: "a" }, { key: "b" }])).toBe(false);
  });

  it("honours an explicit right axis", () => {
    const s = [{ key: "retail" }, { key: "cex", axis: "right" as const }];
    expect(assignAxes(s)).toEqual({ retail: "left", cex: "right" });
    expect(keysOnAxis(s, "right")).toEqual(["cex"]);
    expect(hasRightAxis(s)).toBe(true);
  });

  it("never lets different units share an axis", () => {
    const s = [
      { key: "holders", unit: "wallets" },
      { key: "balance", unit: "TEL" },
      { key: "more", unit: "wallets" },
    ];
    expect(assignAxes(s)).toEqual({ holders: "left", balance: "right", more: "left" });
  });

  it("does not create a lone right axis when every series asks for it", () => {
    expect(hasRightAxis([{ key: "x", axis: "right" }])).toBe(false);
  });
});
