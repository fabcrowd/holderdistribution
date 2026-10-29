import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_FEEDS,
  resolveFeedHealth,
  evaluateFeed,
  isUnhealthy,
  findHistoryGaps,
  holderDayChanges,
  resolveConsistencyOptions,
  placeholderLag,
  evaluateProjectHealth,
  evaluateAllProjects,
} from "./feedHealth.js";
import { resolveProject } from "./projects.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * HOUR).toISOString();

describe("resolveFeedHealth (threshold resolution)", () => {
  it("returns the default table untouched when the project has no health block", () => {
    const feeds = resolveFeedHealth({});
    expect(feeds.map((f) => f.file)).toEqual(DEFAULT_FEEDS.map((f) => f.file));
    expect(feeds.find((f) => f.file === "holders-lite.json").thresholdMs).toBe(36 * HOUR);
    expect(feeds.every((f) => f.placeholder === false)).toBe(true);
  });

  it("lets a project override one feed's maxAgeHours without touching the others", () => {
    const feeds = resolveFeedHealth({ health: { feeds: { "holders-lite.json": { maxAgeHours: 6 } } } });
    expect(feeds.find((f) => f.file === "holders-lite.json").thresholdMs).toBe(6 * HOUR);
    expect(feeds.find((f) => f.file === "tier-outflows.json").thresholdMs).toBe(96 * HOUR);
  });

  it("marks placeholder feeds and drops disabled ones", () => {
    const feeds = resolveFeedHealth({
      health: { feeds: { "tier-outflows.json": { placeholder: true }, "funding-wallets.json": { disabled: true } } },
    });
    expect(feeds.find((f) => f.file === "tier-outflows.json").placeholder).toBe(true);
    expect(feeds.some((f) => f.file === "funding-wallets.json")).toBe(false);
  });

  it("accepts a feed the default table does not know, with its own threshold", () => {
    const feeds = resolveFeedHealth({ health: { feeds: { "solana-staking.json": { maxAgeHours: 30, label: "Staking" } } } });
    const extra = feeds.find((f) => f.file === "solana-staking.json");
    expect(extra.thresholdMs).toBe(30 * HOUR);
    expect(extra.label).toBe("Staking");
  });

  it("rejects a non-positive or non-numeric maxAgeHours", () => {
    for (const bad of [0, -1, "36", null, Infinity]) {
      expect(() => resolveFeedHealth({ health: { feeds: { "holders-lite.json": { maxAgeHours: bad } } } })).toThrow(/maxAgeHours/);
    }
  });
});

describe("evaluateFeed", () => {
  const feed = { file: "x.json", label: "X", thresholdMs: 10 * HOUR, placeholder: false };

  it("classifies healthy, stale, missing and no-timestamp", () => {
    expect(evaluateFeed(feed, { generatedAt: hoursAgo(2) }, NOW).status).toBe("healthy");
    const stale = evaluateFeed(feed, { generatedAt: hoursAgo(11) }, NOW);
    expect(stale.status).toBe("stale");
    expect(stale.ageMs).toBe(11 * HOUR);
    expect(evaluateFeed(feed, null, NOW).status).toBe("missing");
    expect(evaluateFeed(feed, {}, NOW).status).toBe("no-timestamp");
  });

  it("reports a placeholder as PLACEHOLDER whatever its age or presence, and never unhealthy", () => {
    const ph = { ...feed, placeholder: true };
    for (const doc of [null, {}, { generatedAt: hoursAgo(9999) }]) {
      const r = evaluateFeed(ph, doc, NOW);
      expect(r.status).toBe("placeholder");
      expect(isUnhealthy(r)).toBe(false);
    }
  });

  it("treats everything but healthy/placeholder as unhealthy", () => {
    expect(isUnhealthy({ status: "stale" })).toBe(true);
    expect(isUnhealthy({ status: "missing" })).toBe(true);
    expect(isUnhealthy({ status: "no-timestamp" })).toBe(true);
    expect(isUnhealthy({ status: "healthy" })).toBe(false);
  });
});

describe("findHistoryGaps", () => {
  it("anchors the window on today, so a trailing gap is seen", () => {
    const entries = [{ date: "2026-10-24" }, { date: "2026-10-25" }];
    const gaps = findHistoryGaps(entries, { today: new Date("2026-10-28T08:00:00Z"), windowDays: 5 });
    expect(gaps.missing).toEqual(["2026-10-27", "2026-10-26"].sort());
  });

  it("does not count days before the history began", () => {
    const entries = [{ date: "2026-10-26" }, { date: "2026-10-27" }];
    const gaps = findHistoryGaps(entries, { today: new Date("2026-10-28T08:00:00Z"), windowDays: 30 });
    expect(gaps.missing).toEqual([]);
  });

  it("lists rows without a numeric cumulativeHolders", () => {
    const entries = [{ date: "2026-10-27", cumulativeHolders: 5 }, { date: "2026-10-28" }];
    const gaps = findHistoryGaps(entries, { today: new Date("2026-10-29T00:00:00Z"), windowDays: 30 });
    expect(gaps.withoutCumulative).toEqual(["2026-10-28"]);
  });

  it("returns null for an empty history", () => {
    expect(findHistoryGaps([], { today: new Date(NOW) })).toBeNull();
    expect(findHistoryGaps(undefined, { today: new Date(NOW) })).toBeNull();
  });
});

describe("holderDayChanges (day-over-day check)", () => {
  const row = (date, n) => ({ date, combined: { holderCount: n } });

  it("flags a day whose holder count moved more than the threshold", () => {
    const out = holderDayChanges([row("2026-10-25", 1000), row("2026-10-26", 1010), row("2026-10-27", 1100)], { maxPct: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: "2026-10-27", previous: 1010, current: 1100 });
    expect(out[0].pct).toBeCloseTo(8.91, 1);
  });

  it("flags drops as well as jumps, and ignores a change exactly at the threshold", () => {
    expect(holderDayChanges([row("2026-10-26", 1000), row("2026-10-27", 900)], { maxPct: 2 })).toHaveLength(1);
    expect(holderDayChanges([row("2026-10-26", 1000), row("2026-10-27", 1020)], { maxPct: 2 })).toHaveLength(0);
  });

  it("skips allowlisted dates", () => {
    const out = holderDayChanges([row("2026-10-26", 1000), row("2026-10-27", 1500)], { maxPct: 2, allowDates: ["2026-10-27"] });
    expect(out).toEqual([]);
  });

  it("only looks back lookbackDays from the latest entry", () => {
    const rows = [row("2026-08-01", 1000), row("2026-08-02", 2000), row("2026-10-26", 2000), row("2026-10-27", 2001)];
    expect(holderDayChanges(rows, { maxPct: 2, lookbackDays: 30 })).toEqual([]);
  });

  it("tolerates entries without a usable holder count", () => {
    const rows = [row("2026-10-25", 0), { date: "2026-10-26" }, row("2026-10-27", 100)];
    expect(holderDayChanges(rows, { maxPct: 2 })).toEqual([]);
  });
});

describe("resolveConsistencyOptions", () => {
  it("defaults to 2%, 30 days and no allowed dates", () => {
    expect(resolveConsistencyOptions({})).toMatchObject({ maxPct: 2, lookbackDays: 30, allowDates: [], placeholderSlackMs: HOUR });
  });

  it("reads overrides from health.consistency and merges extra dates", () => {
    const o = resolveConsistencyOptions(
      { health: { consistency: { maxHolderChangePct: 5, knownHolderChangeDates: ["2026-10-01"] } } },
      ["2026-10-02"],
    );
    expect(o.maxPct).toBe(5);
    expect(o.allowDates.sort()).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("rejects a non-positive threshold", () => {
    expect(() => resolveConsistencyOptions({ health: { consistency: { maxHolderChangePct: 0 } } })).toThrow(/maxHolderChangePct/);
  });
});

describe("placeholderLag", () => {
  const snapshot = Date.parse("2026-10-28T07:00:00Z");

  it("returns placeholders generated before the snapshot beyond the slack", () => {
    const out = placeholderLag(
      [
        { file: "a.json", doc: { generatedAt: "2026-10-27T07:00:00Z" } },
        { file: "b.json", doc: { generatedAt: "2026-10-28T06:30:00Z" } },
        { file: "c.json", doc: { generatedAt: "2026-10-28T22:00:00Z" } },
      ],
      snapshot,
      HOUR,
    );
    expect(out.map((o) => o.file)).toEqual(["a.json"]);
  });

  it("ignores placeholders with no timestamp or missing files", () => {
    expect(placeholderLag([{ file: "a.json", doc: null }, { file: "b.json", doc: {} }], snapshot, HOUR)).toEqual([]);
  });
});

describe("multi-project iteration", () => {
  let root;
  const writeJson = (rel, value) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "feed-health-"));
    writeJson("config/projects.json", {
      projects: [
        { slug: "alpha", name: "Alpha", ticker: "AAA", default: true },
        { slug: "beta", name: "Beta", ticker: "BBB" },
      ],
    });
    writeJson("config/projects/alpha.json", {
      slug: "alpha",
      data: { legacyRoot: true },
      health: { feeds: { "tier-outflows.json": { placeholder: true }, "cex-wallets.json": { disabled: true }, "funding-wallets.json": { disabled: true }, "exchange-flow-history.json": { disabled: true } } },
    });
    writeJson("config/projects/beta.json", {
      slug: "beta",
      health: { feeds: { "holders-lite.json": { maxAgeHours: 6 }, "tier-outflows.json": { disabled: true }, "cex-wallets.json": { disabled: true }, "funding-wallets.json": { disabled: true }, "exchange-flow-history.json": { disabled: true } } },
    });
    const fresh = { generatedAt: new Date(NOW - HOUR).toISOString() };
    writeJson("public/data/holders-lite.json", fresh);
    writeJson("public/data/holders-history.json", { entries: [{ date: "2026-10-27" }] });
    writeJson("public/data/beta/holders-lite.json", { generatedAt: new Date(NOW - 8 * HOUR).toISOString() });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads each project from its own data dir with its own thresholds", () => {
    const alpha = evaluateProjectHealth(resolveProject("alpha", root), { root, now: NOW });
    expect(alpha.healthy).toBe(true);
    expect(alpha.results.find((r) => r.file === "tier-outflows.json").status).toBe("placeholder");

    const beta = evaluateProjectHealth(resolveProject("beta", root), { root, now: NOW });
    expect(beta.healthy).toBe(false);
    expect(beta.results.find((r) => r.file === "holders-lite.json").status).toBe("stale");
  });

  it("iterates every registered project and is unhealthy if any project is", () => {
    const all = evaluateAllProjects({ root, now: NOW });
    expect(all.projects.map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(all.projects.map((p) => p.healthy)).toEqual([true, false]);
    expect(all.healthy).toBe(false);
  });

  it("restricts to the requested slugs", () => {
    const only = evaluateAllProjects({ root, now: NOW, slugs: ["alpha"] });
    expect(only.projects.map((p) => p.slug)).toEqual(["alpha"]);
    expect(only.healthy).toBe(true);
  });

  it("reports a project whose config is invalid as unhealthy instead of throwing", () => {
    fs.writeFileSync(path.join(root, "config/projects/beta.json"), "{ not json");
    const all = evaluateAllProjects({ root, now: NOW });
    const beta = all.projects.find((p) => p.slug === "beta");
    expect(beta.healthy).toBe(false);
    expect(beta.error).toMatch(/beta/);
    expect(all.healthy).toBe(false);
  });

  it("rejects an unknown slug", () => {
    expect(() => evaluateAllProjects({ root, now: NOW, slugs: ["nope"] })).toThrow(/unknown project/);
  });
});
