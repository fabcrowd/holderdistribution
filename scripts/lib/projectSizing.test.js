import { describe, expect, it } from "vitest";
import { projectSizing } from "./projectSizing.js";

const config = (target, sizing) => ({ slug: "t", supply: { target }, ...(sizing ? { sizing } : {}) });

describe("projectSizing", () => {
  it("reproduces TEL's historical constants exactly at a 100B supply", () => {
    expect(projectSizing(config(100e9))).toEqual({
      minSellerTokens: 5e6,
      minSwapCandidateTokens: 1e6,
      cexCandidateMinBalance: 100_000,
      consistencyToleranceTokens: 1,
    });
  });

  it("scales every threshold with the supply target", () => {
    const small = projectSizing(config(1e6));
    expect(small.minSellerTokens).toBe(50);
    expect(small.minSwapCandidateTokens).toBe(10);
    expect(small.cexCandidateMinBalance).toBe(1);
    const large = projectSizing(config(1e12));
    expect(large.minSellerTokens).toBe(5e7);
    expect(large.minSwapCandidateTokens).toBe(1e7);
    expect(large.cexCandidateMinBalance).toBe(1e6);
    expect(large.consistencyToleranceTokens).toBe(10);
  });

  it("never lets the tolerance fall below one whole token (feeds round differently below that)", () => {
    expect(projectSizing(config(10e9)).consistencyToleranceTokens).toBe(1);
    expect(projectSizing(config(1e3)).consistencyToleranceTokens).toBe(1);
  });

  it("lets a config override win, per key", () => {
    const s = projectSizing(config(100e9, { minSwapCandidateTokens: 250 }));
    expect(s.minSwapCandidateTokens).toBe(250);
    expect(s.minSellerTokens).toBe(5e6);
  });

  it("rejects a bad override or an unknown key", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      expect(() => projectSizing(config(100e9, { minSellerTokens: bad }))).toThrow(/sizing\.minSellerTokens/);
    }
    expect(() => projectSizing(config(100e9, { minSeller: 5 }))).toThrow(/not a known threshold/);
  });

  it("throws a clear error when supply.target is missing or invalid", () => {
    expect(() => projectSizing({ slug: "x" })).toThrow(/supply\.target/);
    expect(() => projectSizing(config(0))).toThrow(/supply\.target/);
    expect(() => projectSizing(config("100"))).toThrow(/supply\.target/);
  });
});
