import { describe, it, expect } from "vitest";
import { summarizeFeed, compareFeeds, checkCexFlowsWindow } from "./feedAlignment.js";

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

describe("checkCexFlowsWindow", () => {
  const st = (date, extra = {}) => ({ date, blocks: { ethereum: 1 }, settled: true, ...extra });
  const cexFlows = (previousDate, currentDate, net, extra = {}) => ({
    asOf: st(currentDate),
    overall: { currentBalance: 1000, previousBalance: 1000 - net, inflow: Math.max(net, 0), outflow: Math.max(-net, 0), net },
    comparison: { available: true, windowDays: 1, previous: st(previousDate), current: st(currentDate) },
    ...extra,
  });
  const history = (date, net, extra = {}) => ({ entries: [{ date, chains: { ethereum: { in: 0, out: 0 } }, in: 0, out: 0, net, ...extra }] });
  const opts = { tolerance: 2 };

  it("passes a correct feed: settled one-day window whose net matches the transaction-level row", () => {
    const r = checkCexFlowsWindow(cexFlows("2026-11-10", "2026-11-11", 5_310_000), history("2026-11-11", 5_310_001), opts);
    expect(r.problems).toEqual([]);
    expect(r.checks).toEqual([expect.stringContaining("2026-11-10 -> 2026-11-11"), expect.stringContaining("agrees with exchange-flow-history[2026-11-11]")]);
  });
  it("fails the HBAR case: previous taken from the wrong day yields a net the settled feed contradicts", () => {
    // The previous snapshot was an older day, but the feed claimed a one-day window.
    const wrongWindow = checkCexFlowsWindow(cexFlows("2026-11-03", "2026-11-10", -440_000), history("2026-11-10", 5_310_000), opts);
    expect(wrongWindow.problems).toEqual([expect.stringContaining("claims a one-day flow but compares 2026-11-03 -> 2026-11-10")]);
    // Even with a (wrongly) adjacent stamp, the amount rule catches the contradiction.
    const wrongAmount = checkCexFlowsWindow(cexFlows("2026-11-09", "2026-11-10", -440_000), history("2026-11-10", 5_310_000), opts);
    expect(wrongAmount.problems).toEqual([]);
    expect(wrongAmount.warnings).toEqual([expect.stringMatching(/differs from exchange-flow-history\[2026-11-10\].*tolerance 2/)]);
  });
  it("fails unordered or non-comparable snapshots", () => {
    expect(checkCexFlowsWindow(cexFlows("2026-11-11", "2026-11-11", 0), null, opts).problems).toEqual([expect.stringContaining("not before")]);
    const unpinned = cexFlows("2026-11-10", "2026-11-11", 0);
    unpinned.comparison.previous = st("2026-11-10", { settled: false, unpinned: ["ethereum"] });
    expect(checkCexFlowsWindow(unpinned, null, opts).problems).toEqual([expect.stringContaining("not both settled/comparable")]);
  });
  it("fails when the recorded current date is not the feed's asOf", () => {
    const f = cexFlows("2026-11-09", "2026-11-10", 0);
    f.asOf = st("2026-11-11");
    expect(checkCexFlowsWindow(f, null, opts).problems).toEqual([expect.stringContaining("comparison.current.date")]);
  });
  it("an honest 'no comparison' feed passes only when its deltas are zero", () => {
    const none = (overall) => ({ asOf: st("2026-11-11"), overall, comparison: { available: false, reason: "gap", previous: st("2026-11-07"), current: st("2026-11-11") } });
    const zero = { currentBalance: 9, previousBalance: 9, inflow: 0, outflow: 0, net: 0 };
    expect(checkCexFlowsWindow(none(zero), history("2026-11-11", 12345), opts).problems).toEqual([]);
    expect(checkCexFlowsWindow(none({ ...zero, previousBalance: 4, net: 5, inflow: 5 }), null, opts).problems).toEqual([expect.stringContaining("still reports a delta")]);
    const noReason = none(zero);
    delete noReason.comparison.reason;
    expect(checkCexFlowsWindow(noReason, null, opts).problems).toEqual([expect.stringContaining("no reason")]);
  });
  it("a feed from before the stamp existed is a warning; the amount rule still applies to it", () => {
    const legacy = cexFlows("2026-11-10", "2026-11-11", 100);
    delete legacy.comparison;
    expect(checkCexFlowsWindow(legacy, history("2026-11-11", 100), opts)).toMatchObject({ problems: [], warnings: [expect.stringContaining("no comparison stamp")] });
    const mismatch = checkCexFlowsWindow(legacy, history("2026-11-11", 9999), opts);
    expect(mismatch.problems).toEqual([]);
    expect(mismatch.warnings).toHaveLength(2);
  });
  it("skips the amount rule, with no failure, for native assets, live reads, partial or absent rows and wallet-list changes", () => {
    const bad = history("2026-11-11", 999_999);
    const base = cexFlows("2026-11-10", "2026-11-11", 5);
    expect(checkCexFlowsWindow(base, bad, { ...opts, nativeAsset: true }).problems).toEqual([]);
    const live = { ...base, asOf: st("2026-11-11", { settled: false, live: ["solana"] }) };
    live.comparison = { available: true, windowDays: 1, previous: st("2026-11-10", { settled: false, live: ["solana"] }), current: live.asOf };
    expect(checkCexFlowsWindow(live, bad, opts).problems).toEqual([]);
    expect(checkCexFlowsWindow(base, history("2026-11-11", 999_999, { partial: true }), opts).problems).toEqual([]);
    expect(checkCexFlowsWindow(base, history("2026-11-12", 999_999), opts).problems).toEqual([]);
    expect(checkCexFlowsWindow(base, bad, { ...opts, walletSetChangeDates: ["2026-11-11"] })).toMatchObject({ problems: [], checks: expect.arrayContaining([expect.stringContaining("wallet list changed")]) });
  });
  it("prints a reason for every skipped amount comparison and never fails", () => {
    const bad = history("2026-11-11", 999_999);
    const reasonOf = (r) => r.checks.filter((c) => c.includes("not compared"));
    const base = cexFlows("2026-11-10", "2026-11-11", 5);
    expect(reasonOf(checkCexFlowsWindow(base, bad, { ...opts, nativeAsset: true }))).toEqual([expect.stringContaining("native asset")]);
    expect(reasonOf(checkCexFlowsWindow(base, history("2026-11-11", 1, { partial: true }), opts))).toEqual([expect.stringContaining("partial")]);
    expect(reasonOf(checkCexFlowsWindow(base, history("2026-11-12", 1), opts))).toEqual([expect.stringContaining("no exchange-flow-history row")]);
    expect(reasonOf(checkCexFlowsWindow(base, bad, { ...opts, walletSetChangeDates: ["2026-11-12"] }))).toEqual([expect.stringContaining("wallet list changed")]);
  });
  it("skips, naming the chain, when the history does not scan a chain the balances include", () => {
    const f = cexFlows("2026-11-10", "2026-11-11", 5);
    f.asOf = st("2026-11-11", { blocks: { ethereum: 1, base: 2 } });
    const onlyEthereum = { entries: [{ date: "2026-11-11", chains: { ethereum: { in: 0, out: 0 } }, in: 0, out: 0, net: 999_999 }] };
    const r = checkCexFlowsWindow(f, onlyEthereum, opts);
    expect(r.warnings).toEqual([]);
    expect(r.checks).toEqual(expect.arrayContaining([expect.stringContaining("no rows for base")]));
    const both = { entries: [{ date: "2026-11-11", chains: { ethereum: {}, base: {} }, in: 0, out: 0, net: 999_999 }] };
    expect(checkCexFlowsWindow(f, both, opts).warnings).toHaveLength(1);
    // base moved only long ago: it is not scanned now
    const stale = { entries: [{ date: "2026-01-01", chains: { base: {} } }, { date: "2026-11-11", chains: { ethereum: {} }, net: 999_999 }] };
    expect(checkCexFlowsWindow(f, stale, opts).warnings).toEqual([]);
  });
  describe("chain with no history rows, proven by the feed's byChain", () => {
    const zero = { previousBalance: 0, currentBalance: 0 };
    const feed = (byChain, blocks = { ethereum: 1, base: 2 }) => {
      const f = cexFlows("2026-11-10", "2026-11-11", 5);
      f.asOf = st("2026-11-11", { blocks });
      if (byChain !== undefined) f.overall.byChain = byChain;
      return f;
    };
    const ethOnly = (net) => history("2026-11-11", net);
    const skipped = (r, ...chains) => {
      expect(r.warnings).toEqual([]);
      expect(r.checks).toEqual(expect.arrayContaining([expect.stringContaining(`no rows for ${chains.join(", ")},`)]));
    };

    it("proven zero in both snapshots: the comparison runs and a net difference warns", () => {
      const r = checkCexFlowsWindow(feed({ ethereum: { previousBalance: 995, currentBalance: 1000 }, base: zero }), ethOnly(999_999), opts);
      expect(r.warnings).toHaveLength(1);
      expect(r.checks).toEqual(expect.arrayContaining(["base: exchange wallets hold none in either snapshot, counted as zero"]));
      expect(r.checks.join("\n")).not.toContain("no rows for");
    });
    it("proven zero and the nets agree: no warning", () => {
      const r = checkCexFlowsWindow(feed({ ethereum: { previousBalance: 995, currentBalance: 1000 }, base: zero }), ethOnly(5), opts);
      expect(r.warnings).toEqual([]);
      expect(r.checks).toEqual(expect.arrayContaining([expect.stringContaining("agrees with exchange-flow-history"), "base: exchange wallets hold none in either snapshot, counted as zero"]));
    });
    it.each([
      ["non-zero current", { previousBalance: 0, currentBalance: 1 }],
      ["non-zero previous", { previousBalance: 1, currentBalance: 0 }],
      ["null per-chain entry", null],
      ["null balances", { previousBalance: null, currentBalance: null }],
      ["non-finite balance", { previousBalance: 0, currentBalance: Number.NaN }],
    ])("%s: still skipped, naming the chain", (_n, base) => {
      skipped(checkCexFlowsWindow(feed({ ethereum: zero, base }), ethOnly(999_999), opts), "base");
    });
    it("missing chain key or missing byChain: still skipped", () => {
      skipped(checkCexFlowsWindow(feed({ ethereum: zero }), ethOnly(999_999), opts), "base");
      skipped(checkCexFlowsWindow(feed(undefined), ethOnly(999_999), opts), "base");
    });
    it("two unscanned chains, one proven zero: still skipped, naming only the unproven one", () => {
      const f = feed({ ethereum: zero, base: zero, polygon: { previousBalance: 0, currentBalance: 3 } }, { ethereum: 1, base: 2, polygon: 3 });
      const r = checkCexFlowsWindow(f, ethOnly(999_999), opts);
      skipped(r, "polygon");
      expect(r.checks.join("\n")).not.toContain("no rows for base");
    });
  });
  it("returns nothing when the feed is absent", () => {
    expect(checkCexFlowsWindow(null, null, opts)).toEqual({ problems: [], warnings: [], checks: [] });
  });
});
