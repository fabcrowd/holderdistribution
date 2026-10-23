import { describe, expect, it } from "vitest";
import { navigate, readSettings, withHash, withSettings } from "./historyNav";

const loc = (hash = "", search = "") => ({ pathname: "/", search, hash });
const fakeHistory = () => {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    pushState: (_d: unknown, _u: string, url: string) => calls.push(["push", url]),
    replaceState: (_d: unknown, _u: string, url: string) => calls.push(["replace", url]),
  };
};

describe("historyNav", () => {
  it("pushes a view change so Back returns to the previous view", () => {
    const h = fakeHistory();
    expect(navigate(h, withHash(loc("#holders"), "#distribution"), "push")).toBe("push");
    expect(h.calls).toEqual([["push", "/#distribution"]]);
  });

  it("does not add a history entry when the hash is unchanged", () => {
    const h = fakeHistory();
    expect(navigate(h, withHash(loc("#supply"), "#supply"), "push")).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it("keeps the query string when the hash changes", () => {
    expect(withHash(loc("#holders", "?range=30"), "#supply/history")).toBe("/?range=30#supply/history");
  });

  it("replaces (never pushes) range/chain and omits defaults", () => {
    const h = fakeHistory();
    const d = { range: 296, chain: "combined" as const };
    navigate(h, withSettings(loc("#distribution"), { range: 30, chain: "base" }, d), "replace");
    expect(h.calls).toEqual([["replace", "/?range=30&chain=base#distribution"]]);
    expect(withSettings(loc("#x", "?range=30&chain=base"), d, d)).toBe("/#x");
    expect(withSettings(loc("#x"), d, d)).toBeNull();
  });

  it("reads only known range and chain values", () => {
    expect(readSettings("?range=30&chain=polygon", [7, 30])).toEqual({ range: 30, chain: "polygon" });
    expect(readSettings("?range=31&chain=solana", [7, 30])).toEqual({ range: null, chain: null });
  });
});
