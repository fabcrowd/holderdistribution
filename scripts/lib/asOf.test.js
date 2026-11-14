import { describe, it, expect } from "vitest";
import { resolveSettledDate, settledBlockFor, buildAsOf, planPins, finalizeAsOf, shouldEmitRow, inheritAsOf, rowDateOf, aheadAction, hasSettledRow, mergeTopLevelAsOf, expectedStamp, snapshotAlreadyPublished } from "./asOf.js";

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
  it("checkpoint past the pin: no-op when the settled row exists, otherwise snapshot unpinned", () => {
    const { ahead } = planPins({ settledDate: "2026-11-05", cutoffMap: cutoffs, chains: [{ key: "ethereum", checkpointBlock: 1200 }] });
    expect(ahead).toEqual(["ethereum"]);
    expect(aheadAction({ ahead, settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-05", asOf: { settled: true } }] } })).toBe("noop");
    expect(aheadAction({ ahead, settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-04" }] } })).toBe("unpin");
    expect(aheadAction({ ahead, settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-05", asOf: { settled: false } }] } })).toBe("unpin");
    expect(hasSettledRow(null, "2026-11-05")).toBe(false);
  });
  it("pins Hedera even when its checkpoint is past the settled block (it reads a snapshot at any past time)", () => {
    const plan = planPins({
      settledDate: "2026-11-05",
      cutoffMap: { hedera: { "2026-11-06": 102_000_000 } },
      chains: [{ key: "hedera", vm: "hedera", checkpointBlock: 102_050_000 }],
    });
    expect(plan).toMatchObject({ pins: { hedera: 101_999_999 }, ahead: [], live: [], unpinned: [] });
  });
  it("a legacy unstamped row is not settled; only a row marked settled:true counts", () => {
    expect(hasSettledRow({ entries: [{ date: "2026-11-05", combined: { holderCount: 5 } }] }, "2026-11-05")).toBe(false);
    expect(hasSettledRow({ entries: [{ date: "2026-11-05", settled: true }] }, "2026-11-05")).toBe(true);
    expect(aheadAction({ ahead: ["ethereum"], settledDate: "2026-11-05", history: { entries: [{ date: "2026-11-05" }] } })).toBe("unpin");
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

describe("expectedStamp / snapshotAlreadyPublished (same-day rerun gate)", () => {
  const evm = { chains: [{ key: "ethereum" }, { key: "polygon", vm: "evm" }] };
  const sol = { chains: [{ key: "solana", vm: "solana" }] };
  const mixed = { chains: [{ key: "ethereum" }, { key: "solana" }] };
  const hedera = { chains: [{ key: "hedera", vm: "hedera" }] };
  const now = new Date("2026-11-14T01:07:00Z");
  const settledStamp = (date) => ({ date, blocks: { ethereum: 1 }, settled: true });
  const liveStamp = (date) => ({ date, blocks: { solana: 1 }, settled: false, live: ["solana"] });

  it("EVM and Hedera projects expect the settled previous day", () => {
    expect(expectedStamp(evm, now)).toEqual({ date: "2026-11-13", settled: true });
    expect(expectedStamp(hedera, now)).toEqual({ date: "2026-11-13", settled: true });
  });
  it("a Solana project, alone or mixed with EVM, expects live with the run day", () => {
    expect(expectedStamp(sol, now)).toEqual({ date: "2026-11-14", settled: false });
    expect(expectedStamp(mixed, now)).toEqual({ date: "2026-11-14", settled: false });
  });
  it("uses the UTC day at the day edges", () => {
    expect(expectedStamp(evm, new Date("2026-11-14T00:00:30Z")).date).toBe("2026-11-13");
    expect(expectedStamp(evm, new Date("2026-11-14T23:59:30Z")).date).toBe("2026-11-13");
    expect(expectedStamp(sol, new Date("2026-11-14T00:00:30Z")).date).toBe("2026-11-14");
    expect(expectedStamp(sol, new Date("2026-11-14T23:59:30Z")).date).toBe("2026-11-14");
  });

  it("first run of the day (committed stamp is the day before) is not published", () => {
    expect(snapshotAlreadyPublished(settledStamp("2026-11-12"), expectedStamp(evm, now))).toBe(false);
    expect(snapshotAlreadyPublished(liveStamp("2026-11-13"), expectedStamp(sol, now))).toBe(false);
  });
  it("a same-day settled rerun and a same-day live rerun are published", () => {
    expect(snapshotAlreadyPublished(settledStamp("2026-11-13"), expectedStamp(evm, now))).toBe(true);
    expect(snapshotAlreadyPublished(liveStamp("2026-11-14"), expectedStamp(sol, now))).toBe(true);
  });
  it("a settled committed stamp never satisfies a live expectation, nor the reverse", () => {
    expect(snapshotAlreadyPublished(settledStamp("2026-11-14"), expectedStamp(sol, now))).toBe(false);
    expect(snapshotAlreadyPublished(liveStamp("2026-11-13"), expectedStamp(evm, now))).toBe(false);
  });
  it("a stamp with unpinned or incomplete entries is not published", () => {
    expect(snapshotAlreadyPublished({ ...settledStamp("2026-11-13"), unpinned: ["base"] }, expectedStamp(evm, now))).toBe(false);
    expect(snapshotAlreadyPublished({ ...settledStamp("2026-11-13"), incomplete: ["base"] }, expectedStamp(evm, now))).toBe(false);
    expect(snapshotAlreadyPublished({ ...liveStamp("2026-11-14"), incomplete: ["solana"] }, expectedStamp(sol, now))).toBe(false);
  });
  it("a stamp with a non-empty noBlock list is not a complete publication; an empty one is", () => {
    const exp = expectedStamp(evm, now);
    expect(snapshotAlreadyPublished({ ...settledStamp("2026-11-13"), noBlock: ["base"] }, exp)).toBe(false);
    expect(snapshotAlreadyPublished({ ...settledStamp("2026-11-13"), noBlock: [] }, exp)).toBe(true);
  });
  it("a mixed EVM + Solana project expects a live stamp dated the run day", () => {
    expect(expectedStamp(mixed, new Date("2026-11-14T23:59:30Z"))).toEqual({ date: "2026-11-14", settled: false });
  });
  it("missing, null or unstamped asOf is not published", () => {
    const exp = expectedStamp(evm, now);
    expect(snapshotAlreadyPublished(undefined, exp)).toBe(false);
    expect(snapshotAlreadyPublished(null, exp)).toBe(false);
    expect(snapshotAlreadyPublished({}, exp)).toBe(false);
  });
});
