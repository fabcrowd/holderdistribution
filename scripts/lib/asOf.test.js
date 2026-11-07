import { describe, it, expect } from "vitest";
import { resolveSettledDate, settledBlockFor, buildAsOf, planPins, finalizeAsOf, shouldEmitRow, inheritAsOf, rowDateOf, aheadAction, hasSettledRow, mergeTopLevelAsOf } from "./asOf.js";

const cutoffs = { ethereum: { "2026-11-06": 1000, "2026-11-05": 900 }, polygon: { "2026-11-06": 5000 } };

describe("resolveSettledDate", () => {
  it("defaults to yesterday UTC", () => {
    expect(resolveSettledDate({ now: new Date("2026-11-06T00:30:00Z") })).toBe("2026-11-05");
    expect(resolveSettledDate({ now: new Date("2026-11-01T23:59:59Z") })).toBe("2026-10-31");
  });
  it("honours --as-of but refuses today or later", () => {
    const now = new Date("2026-11-06T05:00:00Z");
    expect(resolveSettledDate({ asOf: "2026-11-01", now })).toBe("2026-11-01");
    expect(() => resolveSettledDate({ asOf: "2026-11-06", now })).toThrow(/not a settled day/);
    expect(() => resolveSettledDate({ asOf: "2026-13-01", now })).toThrow(/bad date/);
  });
});

describe("settledBlockFor / buildAsOf", () => {
  it("end of D-1 is cutoff[D] - 1", () => {
    expect(settledBlockFor(cutoffs, "ethereum", "2026-11-05")).toBe(999);
    expect(settledBlockFor(cutoffs, "base", "2026-11-05")).toBeNull();
  });
  it("stamps known blocks and lists chains without one", () => {
    expect(buildAsOf("2026-11-05", cutoffs, { chains: ["ethereum", "polygon", "base"] })).toEqual({
      date: "2026-11-05",
      blocks: { ethereum: 999, polygon: 4999 },
      settled: true,
      noBlock: ["base"],
    });
    expect(buildAsOf("2026-11-04", cutoffs, { chains: ["ethereum"] })).toEqual({ date: "2026-11-04", blocks: { ethereum: 899 }, settled: true });
  });
});

describe("planPins / finalizeAsOf", () => {
  it("pins EVM chains, leaves Solana live, flags unresolvable or overtaken EVM chains", () => {
    const plan = planPins({
      settledDate: "2026-11-05",
      cutoffMap: cutoffs,
      chains: [
        { key: "ethereum", vm: "evm", checkpointBlock: 950 },
        { key: "polygon", checkpointBlock: 6000 },
        { key: "base" },
        { key: "solana", vm: "solana" },
      ],
    });
    expect(plan).toEqual({ pins: { ethereum: 999 }, live: ["solana"], unpinned: ["base"], ahead: ["polygon"] });
  });
  it("checkpoint exactly at the settled block still pins (same-day rerun) and is a no-op scan", () => {
    const plan = planPins({ settledDate: "2026-11-05", cutoffMap: cutoffs, chains: [{ key: "ethereum", checkpointBlock: 999 }] });
    expect(plan.pins).toEqual({ ethereum: 999 });
    expect(plan.ahead).toEqual([]);
    // fetchChainBalances scans fromBlock = checkpoint + 1 .. pin: an empty range.
    expect(999 + 1 > plan.pins.ethereum).toBe(true);
    expect(aheadAction({ ahead: plan.ahead, settledDate: "2026-11-05", history: { entries: [] } })).toBe("scan");
  });
  it("checkpoint past the pin: no-op when the settled row exists, fails loudly when it does not", () => {
    const { ahead } = planPins({ settledDate: "2026-11-05", cutoffMap: cutoffs, chains: [{ key: "ethereum", checkpointBlock: 1200 }] });
    expect(ahead).toEqual(["ethereum"]);
    expect(aheadAction({ ahead, settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-05", asOf: { settled: true } }] } })).toBe("noop");
    expect(() => aheadAction({ ahead, settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-04" }] } })).toThrow(/no settled 2026-11-05 row/);
    expect(() => aheadAction({ ahead, settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-05", asOf: { settled: false } }] } })).toThrow();
    expect(hasSettledRow(null, "2026-11-05")).toBe(false);
  });
  it("a legacy unstamped row is not settled; only a row marked settled:true counts", () => {
    expect(hasSettledRow({ entries: [{ date: "2026-11-05", combined: { holderCount: 5 } }] }, "2026-11-05")).toBe(false);
    expect(hasSettledRow({ entries: [{ date: "2026-11-05", settled: true }] }, "2026-11-05")).toBe(true);
    expect(() => aheadAction({ ahead: ["ethereum"], settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-05" }] } })).toThrow();
  });
  it("settled only when every chain is pinned; otherwise dated the run day", () => {
    expect(finalizeAsOf({ settledDate: "2026-11-05", runDay: "2026-11-06", blocks: { ethereum: 999 } })).toEqual({
      date: "2026-11-05",
      blocks: { ethereum: 999 },
      settled: true,
    });
    const live = finalizeAsOf({ settledDate: "2026-11-05", runDay: "2026-11-06", blocks: { solana: 42 }, live: ["solana"] });
    expect(live).toEqual({ date: "2026-11-06", blocks: { solana: 42 }, settled: false, live: ["solana"] });
    expect(shouldEmitRow(live)).toBe(true);
    const unpinned = finalizeAsOf({ settledDate: "2026-11-05", runDay: "2026-11-06", unpinned: ["base"] });
    expect(shouldEmitRow(unpinned)).toBe(false);
    expect(shouldEmitRow(null)).toBe(true);
  });
});

describe("inheritAsOf / rowDateOf", () => {
  it("copies the stamp and prefers asOf.date over snapshotDate", () => {
    const snap = { asOf: { date: "2026-11-05", blocks: { ethereum: 1 }, settled: true }, source: { snapshotDate: "2026-11-06" } };
    const copy = inheritAsOf(snap);
    expect(copy).toEqual(snap.asOf);
    expect(copy.blocks).not.toBe(snap.asOf.blocks);
    expect(inheritAsOf({})).toBeNull();
    expect(rowDateOf(snap)).toBe("2026-11-05");
    expect(rowDateOf({ source: { snapshotDate: "2026-11-06" } })).toBe("2026-11-06");
  });
});

describe("mergeTopLevelAsOf", () => {
  const nightly = { date: "2026-11-05", blocks: { ethereum: 999 }, settled: true };
  const gapFill = { date: "2026-10-20", blocks: { ethereum: 500 }, settled: true };
  it("never moves the top-level stamp backwards (gap fill of an older day)", () => {
    expect(mergeTopLevelAsOf(nightly, gapFill)).toBe(nightly);
  });
  it("takes a same-day or later incoming stamp", () => {
    const later = { ...nightly, date: "2026-11-06" };
    expect(mergeTopLevelAsOf(nightly, later)).toBe(later);
    const same = { ...nightly, blocks: { ethereum: 1000 } };
    expect(mergeTopLevelAsOf(nightly, same)).toBe(same);
  });
  it("keeps existing when there is no incoming stamp, and takes incoming when there is no existing one", () => {
    expect(mergeTopLevelAsOf(nightly, null)).toBe(nightly);
    expect(mergeTopLevelAsOf(null, gapFill)).toBe(gapFill);
    expect(mergeTopLevelAsOf(undefined, null)).toBeNull();
  });
  it("a dated stamp outranks a date-null one either way", () => {
    const undated = { date: null, blocks: {}, settled: false };
    expect(mergeTopLevelAsOf(nightly, undated)).toBe(nightly);
    expect(mergeTopLevelAsOf(undated, gapFill)).toBe(gapFill);
  });
});
