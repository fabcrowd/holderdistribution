import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildCexFlows, buildCexFlowsFromSnapshots, canRotatePrevious, isComparableStamp, snapshotComparison, summaryCexTotals } from "./cexFlows.js";

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const C = `0x${"c".repeat(40)}`;
const list = { generatedAt: "2026-11-01T00:00:00.000Z", wallets: [{ address: A, label: "Alpha" }, { address: B, label: "Alpha" }, { address: C, label: "Beta" }] };
const wallets = (a, b, c) => [{ address: A, total_telcoin_balance: a }, { address: B, total_telcoin_balance: b }, { address: C, total_telcoin_balance: c }];
const stamp = (date, extra = {}) => ({ date, blocks: { ethereum: 100 }, settled: true, ...extra });
const snap = (date, w, extra) => ({ asOf: stamp(date, extra), wallets: w });

const CURRENT = snap("2026-11-11", wallets(150, 40, 10));
const PREVIOUS = snap("2026-11-10", wallets(100, 60, 10));
const strip = ({ generatedAt, comparison, ...rest }) => rest;

describe("snapshotComparison", () => {
  it("is available for settled snapshots one day apart and copies both stamps", () => {
    const c = snapshotComparison(CURRENT.asOf, PREVIOUS.asOf);
    expect(c).toEqual({ available: true, windowDays: 1, previous: PREVIOUS.asOf, current: CURRENT.asOf });
    expect(c.previous).not.toBe(PREVIOUS.asOf);
  });
  it("accepts a live-read chain (settled:false, live) like the daily row does", () => {
    const live = (d) => ({ date: d, blocks: { solana: 1 }, settled: false, live: ["solana"] });
    expect(snapshotComparison(live("2026-11-11"), live("2026-11-10")).available).toBe(true);
  });
  it.each([
    ["same-day rerun", stamp("2026-11-11"), stamp("2026-11-11"), "not-ordered"],
    ["previous newer than current (pinned backfill)", stamp("2026-11-05"), stamp("2026-11-10"), "not-ordered"],
    ["skipped night", stamp("2026-11-11"), stamp("2026-11-08"), "gap"],
    ["unpinned previous", stamp("2026-11-11"), stamp("2026-11-10", { settled: false, unpinned: ["ethereum"] }), "previous-not-comparable"],
    ["unpinned current", stamp("2026-11-11", { settled: false, unpinned: ["ethereum"] }), stamp("2026-11-10"), "current-not-comparable"],
    ["unstamped previous", stamp("2026-11-11"), undefined, "previous-unstamped"],
    ["previous with no date", stamp("2026-11-11"), { date: null, blocks: {}, settled: false }, "previous-not-comparable"],
  ])("%s is unavailable (%s)", (_name, current, previous, reason) => {
    expect(snapshotComparison(current, previous)).toMatchObject({ available: false, reason });
  });
  it("reports the window length on a gap", () => {
    expect(snapshotComparison(stamp("2026-11-11"), stamp("2026-11-08")).windowDays).toBe(3);
  });
});

describe("canRotatePrevious", () => {
  it("rotates a comparable earlier day", () => {
    expect(canRotatePrevious(stamp("2026-11-10"), stamp("2026-11-11"))).toBe(true);
    expect(canRotatePrevious(stamp("2026-11-05"), stamp("2026-11-11"))).toBe(true);
  });
  it("rotates a settled prior even when the new snapshot is an unpinned intraday read", () => {
    expect(canRotatePrevious(stamp("2026-11-10"), stamp("2026-11-11", { settled: false, unpinned: ["ethereum"] }))).toBe(true);
  });
  it("never rotates a same-day rerun, a later day, an unpinned prior or an unstamped prior", () => {
    expect(canRotatePrevious(stamp("2026-11-11"), stamp("2026-11-11"))).toBe(false);
    expect(canRotatePrevious(stamp("2026-11-12"), stamp("2026-11-11"))).toBe(false);
    expect(canRotatePrevious(stamp("2026-11-10", { unpinned: ["ethereum"] }), stamp("2026-11-11"))).toBe(false);
    expect(canRotatePrevious(undefined, stamp("2026-11-11"))).toBe(false);
    expect(canRotatePrevious(stamp("2026-11-10"), undefined)).toBe(false);
  });
  it("shares its comparable-stamp rule with the comparison", () => {
    expect(isComparableStamp(stamp("2026-11-10", { unpinned: ["base"] }))).toBe(false);
    expect(isComparableStamp({ date: null })).toBe(false);
  });
});

describe("pipeline wiring", () => {
  // pull-holders-rpc.js and pull-cex-wallets.js run main() on import, so the wiring is asserted on source.
  const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  it("pull-holders-rpc rotates previous only through canRotatePrevious", () => {
    const src = source("pull-holders-rpc.js");
    expect(src).toMatch(/if \(priorSnapshot && canRotatePrevious\(priorSnapshot\.asOf, asOf\)\)\s*\{\s*await fs\.writeFile\(PREVIOUS_SNAPSHOT_PATH/);
    expect(src.match(/writeFile\(PREVIOUS_SNAPSHOT_PATH/g)).toHaveLength(1);
  });
  it("pull-cex-wallets builds flows only through buildCexFlowsFromSnapshots", () => {
    const src = source("pull-cex-wallets.js");
    expect(src).toContain("buildCexFlowsFromSnapshots(cexWalletsPayload, snapshot, previousSnapshot)");
    expect(src).not.toMatch(/\bbuildCexFlows\(/);
    expect(src).toContain("summaryCexTotals(cexFlows.overall)");
    expect(src).not.toContain("...cexFlows.overall");
  });
});

describe("summaryCexTotals", () => {
  it("drops byChain, keeps every other key in order, and does not mutate its input", () => {
    const overall = { walletCount: 3, currentBalance: 200, net: 30, byChain: { ethereum: { previousBalance: 170, currentBalance: 200 } } };
    const before = JSON.parse(JSON.stringify(overall));
    const totals = summaryCexTotals(overall);
    expect(Object.keys(totals)).toEqual(["walletCount", "currentBalance", "net"]);
    expect(totals).toEqual({ walletCount: 3, currentBalance: 200, net: 30 });
    expect(overall).toEqual(before);
    expect(totals).not.toBe(overall);
  });
  it("an input without byChain comes back equal", () => {
    const overall = { walletCount: 2, inflow: 5, outflow: 1, net: 4 };
    expect(summaryCexTotals(overall)).toEqual(overall);
    expect(summaryCexTotals(overall)).not.toBe(overall);
  });
});

describe("overall.byChain", () => {
  const D = `0x${"d".repeat(40)}`;
  const chainList = { wallets: [{ address: A, label: "Alpha" }, { address: B, label: "Alpha" }, { address: D, label: "Beta" }] };
  const row = (address, eth, pol, base) => ({ address, ethereum_balance: eth, polygon_balance: pol, base_balance: base, total_telcoin_balance: eth + pol + base });
  const chains = ["ethereum", "polygon", "base"];
  const current = [row(A, 150, 10, 0), row(B, 40, 0, 0), row(D, 0, 0, 0)];
  const previous = [row(A, 100, 20, 0), row(B, 60, 0, 0), row(D, 0, 0, 0)];

  it("keys mirror the chains given, in order; an explicit 0 where no exchange wallet holds any", () => {
    const { overall } = buildCexFlows(chainList, current, previous, chains);
    expect(Object.keys(overall.byChain)).toEqual(chains);
    expect(overall.byChain.base).toEqual({ previousBalance: 0, currentBalance: 0 });
    expect(overall.byChain.polygon).toEqual({ previousBalance: 20, currentBalance: 10 });
  });
  it("sums include wallets dropped from wallets[], and match the overall totals", () => {
    const flows = buildCexFlows(chainList, current, previous, chains);
    expect(flows.exchanges.flatMap((e) => e.wallets).map((w) => w.address)).not.toContain(D);
    const sum = (k) => Object.values(flows.overall.byChain).reduce((s, c) => s + c[k], 0);
    expect(sum("currentBalance")).toBeCloseTo(flows.overall.currentBalance, 6);
    expect(sum("previousBalance")).toBeCloseTo(flows.overall.previousBalance, 6);
    const onlyDropped = buildCexFlows(chainList, [row(D, 0, 0, 0)], [row(D, 0, 0, 0)], chains);
    expect(onlyDropped.overall.byChain.base).toEqual({ previousBalance: 0, currentBalance: 0 });
  });
  it("a wallet held only in the previous snapshot still counts there", () => {
    const flows = buildCexFlows(chainList, [row(A, 0, 0, 0)], [row(A, 0, 0, 7)], chains);
    expect(flows.overall.byChain.base).toEqual({ previousBalance: 7, currentBalance: 0 });
  });
  it("a single-chain feed uses the row total", () => {
    const flows = buildCexFlows(list, wallets(150, 40, 10), wallets(100, 60, 10), ["solana"]);
    expect(flows.overall.byChain).toEqual({ solana: { previousBalance: 170, currentBalance: 200 } });
  });
  it("a multi-chain row lacking a per-chain field gives null, never 0", () => {
    const partial = [{ address: A, ethereum_balance: 5, total_telcoin_balance: 5 }];
    const flows = buildCexFlows(chainList, partial, partial, ["ethereum", "base"]);
    expect(flows.overall.byChain.ethereum).toEqual({ previousBalance: 5, currentBalance: 5 });
    expect(flows.overall.byChain.base).toEqual({ previousBalance: null, currentBalance: null });
  });
  it("no chains (no asOf.blocks): byChain is omitted", () => {
    expect(buildCexFlows(chainList, current, previous).overall).not.toHaveProperty("byChain");
    const flows = buildCexFlowsFromSnapshots(chainList, { asOf: { date: "2026-11-11", settled: true }, wallets: current }, null);
    expect(flows.overall).not.toHaveProperty("byChain");
  });
  it("an unavailable comparison reads previous = current per chain", () => {
    const flows = buildCexFlowsFromSnapshots(chainList, { asOf: stamp("2026-11-11", { blocks: { ethereum: 1, polygon: 1, base: 1 } }), wallets: current }, null);
    expect(flows.overall.byChain.polygon).toEqual({ previousBalance: 10, currentBalance: 10 });
  });
});

describe("buildCexFlowsFromSnapshots", () => {
  it("normal nightly case: flow fields are exactly buildCexFlows on the two wallet lists; only `comparison` is added", () => {
    const flows = buildCexFlowsFromSnapshots(list, CURRENT, PREVIOUS);
    expect(strip(flows)).toEqual(strip(buildCexFlows(list, CURRENT.wallets, PREVIOUS.wallets, ["ethereum"])));
    expect(flows.comparison).toMatchObject({ available: true, windowDays: 1 });
    expect(flows.overall).toMatchObject({ currentBalance: 200, previousBalance: 170, inflow: 50, outflow: 20, net: 30 });
    expect(flows.exchanges.map((e) => [e.name, e.net])).toEqual([["Alpha", 30], ["Beta", 0]]);
    expect(Object.keys(flows)).toEqual(["generatedAt", "listUpdatedAt", "overall", "exchanges", "comparison"]);
  });
  it.each([
    ["same-day rerun", snap("2026-11-11", wallets(100, 60, 10))],
    ["unpinned previous", snap("2026-11-10", wallets(100, 60, 10), { settled: false, unpinned: ["ethereum"] })],
    ["multi-day gap", snap("2026-11-07", wallets(100, 60, 10))],
    ["previous with no asOf", { wallets: wallets(100, 60, 10) }],
  ])("%s: previous balances are withheld, deltas read zero, comparison says why", (_n, previous) => {
    const flows = buildCexFlowsFromSnapshots(list, CURRENT, previous);
    expect(flows.comparison.available).toBe(false);
    expect(flows.comparison.reason).toEqual(expect.any(String));
    expect(flows.overall).toMatchObject({ currentBalance: 200, previousBalance: 200, inflow: 0, outflow: 0, net: 0 });
  });
  it("gap comparison names both snapshots so a reader can see the window", () => {
    const flows = buildCexFlowsFromSnapshots(list, CURRENT, snap("2026-11-07", wallets(1, 1, 1)));
    expect(flows.comparison).toMatchObject({ reason: "gap", windowDays: 4, previous: { date: "2026-11-07" }, current: { date: "2026-11-11" } });
  });
  it("first run: no previous snapshot", () => {
    const flows = buildCexFlowsFromSnapshots(list, CURRENT, null);
    expect(flows.comparison).toMatchObject({ available: false, reason: "no-previous-snapshot", previous: null });
    expect(flows.overall.net).toBe(0);
  });
  it("a valid previous with no wallets is not a comparison", () => {
    const flows = buildCexFlowsFromSnapshots(list, CURRENT, snap("2026-11-10", []));
    expect(flows.comparison).toMatchObject({ available: false, reason: "previous-empty" });
    expect(flows.overall.net).toBe(0);
  });
  it("returns null without a wallet list", () => {
    expect(buildCexFlowsFromSnapshots({ wallets: [] }, CURRENT, PREVIOUS)).toBeNull();
  });
});
