import { describe, expect, it } from "vitest";
import { buildViewHash, parseViewHash } from "./viewRoute";

describe("parseViewHash", () => {
  it("defaults an empty hash to Holders with no panel", () => {
    expect(parseViewHash("")).toEqual({ view: "holders", panel: null });
    expect(parseViewHash("#")).toEqual({ view: "holders", panel: null });
  });
  it("reads plain view hashes", () => {
    expect(parseViewHash("#distribution")).toEqual({ view: "distribution", panel: null });
    expect(parseViewHash("#supply")).toEqual({ view: "supply", panel: null });
  });
  it("reads view/panel deep links and validates the panel", () => {
    expect(parseViewHash("#holders/flows")).toEqual({ view: "holders", panel: "flows" });
    expect(parseViewHash("#supply/wallet-flows")).toEqual({ view: "supply", panel: "wallet-flows" });
    expect(parseViewHash("#holders/nope")).toEqual({ view: "holders", panel: null });
    expect(parseViewHash("#distribution/flows")).toEqual({ view: "distribution", panel: null });
  });
  it("keeps the legacy #overview link working", () => {
    expect(parseViewHash("#overview")).toEqual({ view: "holders", panel: null });
  });
  it("ignores non-view anchors such as the skip link", () => {
    expect(parseViewHash("#main-content")).toBeNull();
  });
});

describe("buildViewHash", () => {
  it("round-trips", () => {
    for (const h of ["#holders", "#holders/trends", "#distribution", "#supply/history"]) {
      expect(buildViewHash(parseViewHash(h)!)).toBe(h);
    }
  });
  it("drops invalid panels", () => {
    expect(buildViewHash({ view: "distribution", panel: "x" })).toBe("#distribution");
  });
});
