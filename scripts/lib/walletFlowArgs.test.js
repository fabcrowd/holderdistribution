import path from "node:path";
import { describe, expect, it } from "vitest";
import { anchorSeconds, parseAsOf, parseWalletFlowArgs } from "./walletFlowArgs.js";

const ROOT = path.resolve("/fake-root");
const LIVE_OUT = path.join(ROOT, "data", "forensics", "wallet-flows.json");
const NOW_MS = Date.parse("2026-10-31T12:00:00.000Z");

const parse = (argv) => parseWalletFlowArgs({ argv, root: ROOT, liveOut: LIVE_OUT, nowMs: NOW_MS });

describe("parseAsOf", () => {
  it("reads a date as UTC midnight", () => {
    expect(parseAsOf("2026-09-01", { nowMs: NOW_MS })).toEqual({
      ts: Date.parse("2026-09-01T00:00:00Z") / 1000,
      iso: "2026-09-01T00:00:00.000Z",
    });
  });

  it("reads an ISO timestamp with an explicit offset", () => {
    expect(parseAsOf("2026-09-01T06:30:00+02:00", { nowMs: NOW_MS }).iso).toBe("2026-09-01T04:30:00.000Z");
  });

  it.each(["2026-9-1", "yesterday", "", "2026-09-01T10:00", "2026/09/01", "2026-02-31"])("rejects %j", (raw) => {
    expect(() => parseAsOf(raw, { nowMs: NOW_MS })).toThrow(/--as-of/);
  });

  it("rejects a future date", () => {
    expect(() => parseAsOf("2026-11-01", { nowMs: NOW_MS })).toThrow(/future/);
  });
});

describe("parseWalletFlowArgs", () => {
  it("returns no anchor and no out when no backfill flags are given (default run)", () => {
    expect(parse([])).toEqual({ asOf: null, out: null });
  });

  it("accepts --as-of with an explicit --out under data/", () => {
    const got = parse(["--as-of", "2026-09-01", "--out", "data/forensics/backfill-2026-09-01.json"]);
    expect(got.asOf.iso).toBe("2026-09-01T00:00:00.000Z");
    expect(got.out).toBe(path.join(ROOT, "data", "forensics", "backfill-2026-09-01.json"));
  });

  it("requires --out whenever --as-of is given", () => {
    expect(() => parse(["--as-of", "2026-09-01"])).toThrow(/--as-of requires --out/);
  });

  it("rejects --as-of with --out pointing at the live report", () => {
    expect(() => parse(["--as-of", "2026-09-01", "--out", "data/forensics/wallet-flows.json"])).toThrow(/live report/);
  });

  it("allows --out without --as-of (unchanged behaviour)", () => {
    expect(parse(["--out", "data/forensics/other.json"]).out).toBe(path.join(ROOT, "data", "forensics", "other.json"));
  });

  it.each([
    ["public/data/wallet-flows.json"],
    ["./public/x.json"],
    ["data/../public/x.json"],
    ["public"],
  ])("rejects --out under public/ (%s)", (out) => {
    expect(() => parse(["--out", out])).toThrow(/public/);
    expect(() => parse(["--as-of", "2026-09-01", "--out", out])).toThrow(/public/);
  });

  it("does not treat a sibling folder that starts with public as public", () => {
    expect(parse(["--out", "data/publicity/x.json"]).out).toBe(path.join(ROOT, "data", "publicity", "x.json"));
  });

  it("rejects a flag with no value", () => {
    expect(() => parse(["--out"])).toThrow(/--out needs a value/);
    expect(() => parse(["--as-of", "--out", "data/x.json"])).toThrow(/--as-of needs a value/);
  });

  it("accepts the inline --as-of=<date> form", () => {
    expect(parse(["--as-of=2026-09-01", "--out", "data/x.json"]).asOf.iso).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("anchorSeconds", () => {
  it("uses the as-of timestamp when given", () => {
    const asOf = parseAsOf("2026-09-01", { nowMs: NOW_MS });
    expect(anchorSeconds(asOf, NOW_MS)).toBe(asOf.ts);
  });

  it("uses now (whole seconds) when there is no as-of", () => {
    expect(anchorSeconds(null, NOW_MS)).toBe(Math.floor(NOW_MS / 1000));
  });
});
