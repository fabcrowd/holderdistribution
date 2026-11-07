import { describe, it, expect } from "vitest";
import { summarizeFeed, compareFeeds } from "./feedAlignment.js";

const gen = "2026-11-06T04:16:00.000Z";

describe("summarizeFeed", () => {
  it("skips partial and same-day rows", () => {
    const s = summarizeFeed("flows", {
      generatedAt: gen,
      entries: [{ date: "2026-11-04" }, { date: "2026-11-05", partial: true }, { date: "2026-11-06" }],
    });
    expect(s).toMatchObject({ endDate: "2026-11-04", rawLastDate: "2026-11-06", stamped: false });
  });
  it("latestDate with partialDate steps back one day", () => {
    expect(summarizeFeed("t", { generatedAt: gen, latestDate: "2026-11-06", partialDate: "2026-11-06" }).endDate).toBe("2026-11-05");
  });
  it("snapshot feed settles the day before generatedAt", () => {
    expect(summarizeFeed("lite", { generatedAt: gen }).endDate).toBe("2026-11-05");
  });
  it("asOf wins and carries blocks", () => {
    const s = summarizeFeed("x", { generatedAt: gen, asOf: { date: "2026-11-05", blocks: { ethereum: 10 } }, entries: [] });
    expect(s).toMatchObject({ endDate: "2026-11-05", stamped: true, blocks: { ethereum: 10 }, blockSource: "asOf" });
  });
  it("records checkpoint lastBlock as a scan head (blockSource checkpoint, info only), never as asOf blocks", () => {
    const s = summarizeFeed("x", { generatedAt: gen, entries: [] }, { chains: { ethereum: { lastBlock: 7 }, solana: {} } });
    expect(s).toMatchObject({ blocks: { ethereum: 7 }, blockSource: "checkpoint" });
    const stamped = summarizeFeed("y", { generatedAt: gen, asOf: { date: "2026-11-05", blocks: { ethereum: 5 } } }, { chains: { ethereum: { lastBlock: 7 } } });
    expect(stamped).toMatchObject({ blocks: { ethereum: 5 }, blockSource: "asOf" });
  });
});

describe("compareFeeds", () => {
  const f = (name, endDate, blocks = null, stamped = true) => ({ name, endDate, blocks, stamped });
  it("passes when aligned", () => {
    const r = compareFeeds([f("a", "2026-11-05", { eth: 5 }), f("b", "2026-11-05", { eth: 5 })]);
    expect(r).toMatchObject({ ok: true, problems: [], warnings: [], blockSpread: { eth: 0 } });
  });
  it("fails on differing end dates", () => {
    const r = compareFeeds([f("a", "2026-11-05"), f("b", "2026-11-04")]);
    expect(r.ok).toBe(false);
    expect(r.endDates).toEqual(["2026-11-04", "2026-11-05"]);
  });
  it("fails on block spread beyond tolerance, passes within", () => {
    const feeds = [f("a", "2026-11-05", { eth: 5 }), f("b", "2026-11-05", { eth: 8 })];
    expect(compareFeeds(feeds).ok).toBe(false);
    expect(compareFeeds(feeds, { blockTolerance: 3 }).ok).toBe(true);
  });
  it("unstamped is a warning, an error under strict", () => {
    const feeds = [f("a", "2026-11-05", null, false)];
    expect(compareFeeds(feeds)).toMatchObject({ ok: true, warnings: [expect.stringContaining("a")] });
    expect(compareFeeds(feeds, { strict: true }).ok).toBe(false);
  });
  it("live (unsettled) feeds: blocks of live chains skipped, dates still compared (1 day allowed)", () => {
    const live = summarizeFeed("sol", { generatedAt: gen, asOf: { date: "2026-11-06", blocks: { solana: 9, ethereum: 5 }, settled: false, live: ["solana"] } });
    expect(live).toMatchObject({ settled: false, live: ["solana"] });
    const r = compareFeeds([f("a", "2026-11-05", { ethereum: 5, solana: 1 }), live]);
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual(["sol: live chain: block comparison skipped (solana)", "solana blocks: live feeds skipped; settled feeds with a solana block are still compared"]);
    expect(r.blockSpread).toEqual({ ethereum: 0 });
    expect(compareFeeds([f("a", "2026-11-05"), live], { strict: true }).ok).toBe(true);
  });
  it("settled flow feeds stamped with a solana slot are compared with each other on blocks, even when a live snapshot feed lists solana", () => {
    const flow = (name, solana) => summarizeFeed(name, { generatedAt: gen, asOf: { date: "2026-11-05", blocks: { solana }, settled: true } });
    expect(compareFeeds([flow("exchange-flow", 199), flow("tier-outflows", 199)])).toMatchObject({ ok: true, blockSpread: { solana: 0 } });
    const bad = compareFeeds([flow("exchange-flow", 199), flow("tier-outflows", 150)]);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual([expect.stringContaining("solana blocks differ by 49")]);
    const live = summarizeFeed("lite", { generatedAt: gen, asOf: { date: "2026-11-06", blocks: { solana: 9 }, settled: false, live: ["solana"] } });
    const mixed = compareFeeds([flow("exchange-flow", 199), flow("tier-outflows", 150), live]);
    expect(mixed.blockSpread).toEqual({ solana: 49 });
    expect(mixed.ok).toBe(false);
    expect(compareFeeds([flow("exchange-flow", 199), flow("tier-outflows", 199), live])).toMatchObject({ ok: true, blockSpread: { solana: 0 } });
  });
  it("asOf.noBlock is surfaced: a warning, a problem under strict", () => {
    const s = summarizeFeed("flows", { generatedAt: gen, asOf: { date: "2026-11-05", blocks: {}, settled: true, noBlock: ["solana"] } });
    expect(s.noBlock).toEqual(["solana"]);
    expect(compareFeeds([s])).toMatchObject({ ok: true, warnings: ["flows: no block recorded for solana (asOf.noBlock)"] });
    const strict = compareFeeds([s], { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.problems).toEqual(["flows: no block recorded for solana (asOf.noBlock)"]);
  });
  it("a live feed more than 1 day off the others is a warning, a failure under strict", () => {
    const stale = summarizeFeed("sol", { generatedAt: gen, asOf: { date: "2026-11-02", blocks: {}, settled: false, live: ["solana"] } });
    const r = compareFeeds([f("a", "2026-11-05"), stale]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.stringContaining("sol=2026-11-02")]);
    const s = compareFeeds([f("a", "2026-11-05"), stale], { strict: true });
    expect(s.ok).toBe(false);
    expect(s.problems).toEqual([expect.stringContaining("live feed date differs by 3 days")]);
  });
  it("an incomplete stamp (asOf.date null) is stamped but has no settled end date", () => {
    const s = summarizeFeed("flows", { generatedAt: gen, asOf: { date: null, blocks: {}, settled: false, incomplete: ["solana"] }, entries: [{ date: "2026-11-05" }] });
    expect(s).toMatchObject({ stamped: true, endDate: null });
    expect(compareFeeds([f("a", "2026-11-05"), s]).ok).toBe(false);
  });
  it("missing end date is a problem", () => {
    expect(compareFeeds([f("a", null)]).ok).toBe(false);
  });
  it("checkpoint scan heads are reported as info, never compared against day cutoffs", () => {
    const cp = summarizeFeed("lite", { generatedAt: gen, entries: [] }, { chains: { ethereum: { lastBlock: 7 } } });
    const r = compareFeeds([{ ...f("a", "2026-11-05", { ethereum: 5 }), blockSource: "asOf" }, { ...cp, endDate: "2026-11-05" }]);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.info).toEqual(["lite: ethereum scan head 7 (checkpoint, not a day cutoff): not compared"]);
    expect(r.blockSpread).toEqual({});
  });
  it("asOf-sourced blocks are still compared", () => {
    const r = compareFeeds([{ ...f("a", "2026-11-05", { ethereum: 5 }), blockSource: "asOf" }, { ...f("b", "2026-11-05", { ethereum: 9 }), blockSource: "asOf" }]);
    expect(r.ok).toBe(false);
  });
  it("a missing expected feed is a warning, a failure under strict", () => {
    const feeds = [f("a", "2026-11-05")];
    expect(compareFeeds(feeds, { missing: ["tier-outflows"] })).toMatchObject({ ok: true, warnings: ["missing feed: tier-outflows"] });
    expect(compareFeeds(feeds, { missing: ["tier-outflows"], strict: true })).toMatchObject({ ok: false, problems: ["missing feed: tier-outflows"] });
  });
});

describe("unpinned chains are not block-compared", () => {
  it("skips a chain listed as unpinned on a feed, the same way as a live chain", () => {
    const flows = summarizeFeed("flows", { generatedAt: gen, asOf: { date: "2026-11-06", blocks: { ethereum: 100 }, settled: true }, entries: [{ date: "2026-11-06" }] });
    const snapshot = summarizeFeed("holders-lite", { generatedAt: gen, asOf: { date: "2026-11-07", blocks: { ethereum: 900 }, settled: false, unpinned: ["ethereum"] }, entries: [{ date: "2026-11-07" }] });
    const result = compareFeeds([flows, snapshot]);
    expect(result.problems.filter((p) => /ethereum blocks differ/.test(p))).toEqual([]);
  });
});
