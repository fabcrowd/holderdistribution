// Names of design 2.1 section 7.1: build and parse round trip; near misses rejected.
import { describe, it, expect } from "vitest";
import {
  packName, parsePackName, gitPackName, parseGitPackName, listName, parseListName, siteRootName, parseSiteRootName,
  releaseTag, parseReleaseTag, parseStoreName, isStoreName, seriesOfName, NameError,
} from "./packNames.js";

const SHA = "a".repeat(64);

describe("pack names", () => {
  it("every pattern builds and parses", () => {
    const p = { cls: "hist", kind: "walletFlows", day: "2026-11-18", run: 44420016156, attempt: 2, lane: 15, flush: 3 };
    const n = packName(p);
    expect(n).toBe("p.hist.walletFlows.2026-11-18.r44420016156a2.l15f3.hdb");
    expect(parsePackName(n)).toEqual(p);
    const g = { cls: "live", day: "2026-01-02", sha: "0123456789ab" };
    expect(parseGitPackName(gitPackName(g))).toEqual(g);
    expect(parseListName(listName(SHA))).toEqual({ sha: SHA });
    const s = { day: "2026-11-18", run: 7, attempt: 1, try: 2 };
    expect(siteRootName(s)).toBe("site.2026-11-18.r7a1p2.json");
    expect(parseSiteRootName(siteRootName(s))).toEqual(s);
    for (const series of ["keep", "hist", "live", "events", "site"]) expect(parseReleaseTag(releaseTag(series, 12))).toEqual({ series, seq: 12 });
    expect(seriesOfName(n)).toBe("hist");
    expect(seriesOfName(listName(SHA))).toBe("keep");
    expect(seriesOfName(siteRootName(s))).toBe("site");
    expect(parseStoreName(n).type).toBe("pack");
    expect(isStoreName(n)).toBe(true);
  });

  it("near misses are rejected", () => {
    const bad = [
      "p.cold.holders.2026-11-18.r1a1.l0f0.hdb", // wrong class
      "p.site.holders.2026-11-18.r1a1.l0f0.hdb", // site is a series, not a pack class
      "p.live.holders.2026-11-18.r1a1.l0.hdb", // missing field
      "p.live.holders.2026-11-18.r1a1.l0f0.hdb.tmp", // extra suffix
      "p.live.holders.2026-11-18.r1a1.l0f0.hdbx",
      "x/p.live.holders.2026-11-18.r1a1.l0f0.hdb", // path separator
      "p.live.holders.2026-11-18.r1a1.l0f0.hdb/..",
      "..\\p.live.holders.2026-11-18.r1a1.l0f0.hdb",
      "P.live.holders.2026-11-18.r1a1.l0f0.hdb", // upper case
      "p.LIVE.holders.2026-11-18.r1a1.l0f0.hdb",
      "p.live.walletflows.2026-11-18.r1a1.l0f0.hdb",
      "p.live.holders.2026-13-18.r1a1.l0f0.hdb", // not a day
      "p.live.holders.2026-11-18.r01a1.l0f0.hdb", // leading zero
      "p.live.holders.2026-11-18.git0123456789AB.hdb",
      "p.live.holders.2026-11-18.git0123456789a.hdb",
      `list.${"A".repeat(64)}.br`,
      `list.${"a".repeat(63)}.br`,
      `list.${SHA}.br.br`,
      "site.2026-11-18.r1a1.json",
      "site.2026-11-18.r1a1p1.JSON",
      "data-live-1",
      "",
    ];
    for (const n of bad) {
      expect(isStoreName(n), n).toBe(false);
      expect(parseStoreName(n), n).toBe(null);
    }
    expect(() => parsePackName("p.cold.holders.2026-11-18.r1a1.l0f0.hdb")).toThrow(NameError);
    expect(() => parseReleaseTag("data-live-0")).toThrow(NameError);
    expect(() => parseReleaseTag("data-live-01")).toThrow(NameError);
    expect(() => parseReleaseTag("data-cold-1")).toThrow(NameError);
    expect(() => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 1, attempt: 1, lane: -1, flush: 0 })).toThrow(NameError);
    expect(() => listName("abc")).toThrow(NameError);
  });

  it("impossible days and numbers over 15 digits are rejected by parser and builder (review minor)", () => {
    for (const n of [
      "p.live.holders.2026-02-31.r1a1.l0f0.hdb",
      "p.live.holders.2025-02-29.r1a1.l0f0.hdb",
      "p.live.holders.2026-11-18.r12345678901234567890a1.l0f0.hdb",
      "p.live.holders.2026-11-18.r1234567890123456a1.l0f0.hdb",
      "site.2026-04-31.r1a1p1.json",
    ]) expect(isStoreName(n), n).toBe(false);
    expect(() => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 12345678901234567890, attempt: 1, lane: 0, flush: 0 })).toThrow(NameError);
    expect(() => packName({ cls: "live", kind: "holders", day: "2026-02-31", run: 1, attempt: 1, lane: 0, flush: 0 })).toThrow(NameError);
    expect(() => parseReleaseTag("data-live-1234567890123456")).toThrow(NameError);
    const max = "p.live.holders.2024-02-29.r999999999999999a1.l0f0.hdb";
    expect(packName(parsePackName(max))).toBe(max); // 15 digits and a leap day round-trip exactly
  });
});
