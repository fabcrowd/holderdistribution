import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  findFirstBlockAtOrAfter,
  findFirstSlotAtOrAfter,
  solanaBlockTimeOrNull,
  cutoffsFromEndOfDayMap,
  asOfFromReached,
  lastCompleteDate,
  requireDayBounds,
  readCutoffMap,
  writeCutoffMap,
  ensureCutoffs,
  midnightSeconds,
  CUTOFF_KEY,
  cutoffScanWindow,
  asOfFromCutoffs,
  endOfDayMapFromCutoffs,
  mergeCutoffMaps,
  datesFromTo,
  dateOfBlock,
  settledEndBlock,
  asOfFromSolanaScan,
  flowFeedAsOf,
  solanaSearchLow,
} from "./dayBlocks.js";

const ts = (times) => async (b) => times[b];

describe("findFirstBlockAtOrAfter", () => {
  const times = [100, 110, 120, 120, 130, 140];
  it("finds first block >= target", async () => {
    expect(await findFirstBlockAtOrAfter(115, ts(times), 0, 5)).toBe(2);
    expect(await findFirstBlockAtOrAfter(120, ts(times), 0, 5)).toBe(2);
    expect(await findFirstBlockAtOrAfter(50, ts(times), 0, 5)).toBe(0);
    expect(await findFirstBlockAtOrAfter(140, ts(times), 0, 5)).toBe(5);
  });
  it("returns null when the chain has not reached the target", async () => {
    expect(await findFirstBlockAtOrAfter(141, ts(times), 0, 5)).toBeNull();
  });
});

describe("solanaBlockTimeOrNull", () => {
  it("maps the precise skipped-slot error to null, passes times through, rethrows others", async () => {
    const call = async (method, [slot]) => {
      expect(method).toBe("getBlockTime");
      if (slot === 1) throw new Error("Slot 1 was skipped, or missing due to ledger jump to recent snapshot");
      if (slot === 2) throw new Error("429 Too Many Requests");
      return 100 + slot;
    };
    const get = solanaBlockTimeOrNull(call);
    expect(await get(0)).toBe(100);
    expect(await get(1)).toBeNull();
    await expect(get(2)).rejects.toThrow(/429/);
  });
  it("throws on pruned / long-term-storage shapes, even when they also say 'was skipped'", async () => {
    const shapes = [
      "Slot 5 was skipped, or missing in long-term storage",
      "Block not available for slot 5",
      "Slot 5 was skipped, or missing due to ledger jump to recent snapshot; block cleaned up",
      "Slot 5 was skipped: purged from ledger",
      "slot 5 was skipped",
    ];
    for (const msg of shapes) {
      const get = solanaBlockTimeOrNull(async () => { throw new Error(msg); });
      await expect(get(5)).rejects.toThrow(msg);
    }
  });
  it("uses the JSON-RPC code when the error carries one", async () => {
    const withCode = (code, message) => async () => { throw Object.assign(new Error(message), { code }); };
    const msg = "Slot 5 was skipped, or missing due to ledger jump to recent snapshot";
    expect(await solanaBlockTimeOrNull(withCode(-32007, msg))(5)).toBeNull();
    await expect(solanaBlockTimeOrNull(withCode(-32004, msg))(5)).rejects.toThrow();
  });
  it("solanaSearchLow bounds the search to a recent window", () => {
    expect(solanaSearchLow(10_000_000, 3)).toBe(10_000_000 - Math.ceil(5 * 216_000 * 1.5));
    expect(solanaSearchLow(1000, 3)).toBe(0);
  });
  it("findFirstSlotAtOrAfter throws when the floor is already past the target (lo too recent)", async () => {
    const times = (s) => 1000 + s;
    await expect(findFirstSlotAtOrAfter(1005, async (s) => times(s), 10, 50)).rejects.toThrow(/search floor/);
    expect(await findFirstSlotAtOrAfter(1015, async (s) => times(s), 10, 50)).toBe(15);
  });
  it("lets findFirstSlotAtOrAfter walk past skipped slots", async () => {
    const call = async (_m, [slot]) => {
      if (slot === 3 || slot === 4) throw new Error(`Slot ${slot} was skipped, or missing due to ledger jump to recent snapshot`);
      return 100 + slot * 5;
    };
    expect(await findFirstSlotAtOrAfter(113, solanaBlockTimeOrNull(call), 0, 8)).toBe(5);
  });
});

describe("findFirstSlotAtOrAfter", () => {
  // null = skipped slot
  const times = [100, null, null, 115, null, 120, null, null, 130];
  const get = async (s) => {
    if (times[s] === undefined) throw new Error("out of range");
    return times[s];
  };
  it("skips unproduced slots", async () => {
    expect(await findFirstSlotAtOrAfter(101, get, 0, 8)).toBe(3);
    expect(await findFirstSlotAtOrAfter(116, get, 0, 8)).toBe(5);
    expect(await findFirstSlotAtOrAfter(121, get, 0, 8)).toBe(8);
    expect(await findFirstSlotAtOrAfter(100, get, 0, 8)).toBe(0);
  });
  it("returns null past head", async () => {
    expect(await findFirstSlotAtOrAfter(131, get, 0, 8)).toBeNull();
  });
  it("retries a transient error and then succeeds", async () => {
    let fails = 2;
    const flaky = async (s) => {
      if (s === 5 && fails-- > 0) throw new Error("429");
      return times[s];
    };
    expect(await findFirstSlotAtOrAfter(116, flaky, 0, 8)).toBe(5);
  });
  it("throws (never guesses) when getBlockTime keeps failing", async () => {
    const throwing = async (s) => {
      if (times[s] == null) throw new Error("429");
      return times[s];
    };
    await expect(findFirstSlotAtOrAfter(116, throwing, 0, 8)).rejects.toThrow(/failed after/);
  });
  it("caps the skipped-slot walk", async () => {
    await expect(findFirstSlotAtOrAfter(101, async (s) => (s === 0 ? 100 : s >= 9 ? 200 : null), 0, 9, { maxWalk: 3 }))
      .rejects.toThrow(/no produced slot/);
  });
  it("ensureCutoffs persists nothing when the resolver throws", async () => {
    const io = memIo();
    await expect(ensureCutoffs(project, ["2026-01-01"], { root: "/r", io, resolvers: { solana: async () => { throw new Error("429"); } } }))
      .rejects.toThrow("429");
    expect(Object.keys(io.files)).toEqual([]);
  });
});

describe("converters", () => {
  it("23:59:59Z map: cutoff[D+1] = lastBlockOfD + 1", () => {
    expect(cutoffsFromEndOfDayMap({ "2026-08-23": { ethereum: 25821305, base: 9 }, "2026-12-31": { ethereum: 1 } })).toEqual({
      ethereum: { "2026-08-24": 25821306, "2027-01-01": 2 },
      base: { "2026-08-24": 10 },
    });
  });
});

const memIo = (initial = {}) => {
  const files = { ...initial };
  return { files, read: (p) => files[p] ?? {}, write: (p, o) => (files[p] = o) };
};
const project = { slug: "x", dataDir: "public/data/x" };

describe("cutoff map io", () => {
  it("write keeps legacy keys and sorts; read returns cutoffs", () => {
    const io = memIo();
    const p = path.resolve("/r", "public/data/x", "date-blocks.json");
    io.files[p] = { ethereum: { "2026-01-01": 5 } };
    writeCutoffMap(project, { ethereum: { "2026-01-02": 9, "2026-01-01": 6 } }, { root: "/r", io });
    expect(io.files[p].ethereum).toEqual({ "2026-01-01": 5 });
    expect(Object.keys(io.files[p][CUTOFF_KEY].ethereum)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(readCutoffMap(project, { root: "/r", io })).toEqual({ ethereum: { "2026-01-01": 6, "2026-01-02": 9 } });
  });
  it("ensureCutoffs resolves only missing dates", async () => {
    const io = memIo();
    writeCutoffMap(project, { ethereum: { "2026-01-01": 6 } }, { root: "/r", io });
    const calls = [];
    const map = await ensureCutoffs(project, ["2026-01-01", "2026-01-02"], {
      root: "/r",
      io,
      resolvers: { ethereum: async (t) => (calls.push(t), 42) },
    });
    expect(calls).toEqual([midnightSeconds("2026-01-02")]);
    expect(map.ethereum).toEqual({ "2026-01-01": 6, "2026-01-02": 42 });
  });
});

const proj = project;

describe("cutoff scan window (flow feeds)", () => {
  // 10-minute blocks starting 2026-11-04 20:00Z; tip at block 200 (2026-11-06 05:20Z).
  const T0 = midnightSeconds("2026-11-04") + 20 * 3600;
  const chainTs = async (b) => T0 + b * 600;

  it("buckets by [cutoff[D], cutoff[D+1]) and ends at cutoff[today]-1, not the tip", async () => {
    const io = memIo();
    const w = await cutoffScanWindow({ project: proj, chain: "base", from: 10, latest: 200, today: "2026-11-06", getBlockTimestamp: chainTs, io, root: "/r" });
    expect(w.cutoffs.base).toEqual({ "2026-11-04": 0, "2026-11-05": 24, "2026-11-06": 168 });
    expect(w.settledBlock).toBe(167);
    expect(w.end).toBe(167);
    expect(w.dateOf(23)).toBe("2026-11-04");
    expect(w.dateOf(24)).toBe("2026-11-05");
    expect(w.dateOf(167)).toBe("2026-11-05");
    expect(readCutoffMap(proj, { io, root: "/r" }).base["2026-11-06"]).toBe(168);
  });

  it("respects maxBlocks and returns nothing to scan when the checkpoint is past the settled end", async () => {
    const io = memIo();
    const a = await cutoffScanWindow({ project: proj, chain: "base", from: 10, latest: 200, maxBlocks: 5, today: "2026-11-06", getBlockTimestamp: chainTs, io, root: "/r" });
    expect(a.end).toBe(14);
    const b = await cutoffScanWindow({ project: proj, chain: "base", from: 180, latest: 200, today: "2026-11-06", getBlockTimestamp: chainTs, io, root: "/r" });
    expect(b.end).toBeLessThan(180);
  });

  it("solana resolves the first produced slot", async () => {
    const io = memIo();
    const times = { 0: 100, 1: null, 2: null, 3: 300, 4: 400 };
    const w = await cutoffScanWindow({
      project: proj, chain: "solana", vm: "solana", from: 0, latest: 4, today: "1970-01-01",
      getBlockTimestamp: async (s) => times[s], io, root: "/r",
    });
    expect(w.cutoffs.solana["1970-01-01"]).toBe(0);
    expect(await findFirstSlotAtOrAfter(250, async (s) => times[s], 0, 4)).toBe(3);
  });

  it("cutoffScanWindow throws when a day from the start through today does not resolve", async () => {
    const io = memIo();
    // Tip at block 100 (2026-11-05 12:40Z): cutoff[2026-11-06] cannot resolve.
    await expect(cutoffScanWindow({ project: proj, chain: "base", from: 10, latest: 100, today: "2026-11-06", getBlockTimestamp: chainTs, io, root: "/r" }))
      .rejects.toThrow(/unresolved day cutoffs 2026-11-06/);
  });

  it("asOfFromSolanaScan: complete scan stamps the day before the scan start; incomplete or unknown claims nothing", () => {
    const cutoffs = { solana: { "2026-11-05": 100, "2026-11-06": 200 }, ethereum: { "2026-11-06": 9 } };
    const done = { solana: { complete: true, scanStartedAt: "2026-11-06T03:00:00.000Z" } };
    expect(asOfFromSolanaScan(cutoffs, done, ["solana"], "2026-11-06")).toEqual({ date: "2026-11-05", blocks: { solana: 199 }, settled: true });
    const old = { solana: { complete: true, scanStartedAt: "2026-11-05T03:00:00.000Z" } };
    expect(asOfFromSolanaScan(cutoffs, old, ["solana"], "2026-11-06")).toEqual({ date: "2026-11-04", blocks: { solana: 99 }, settled: true });
    const partial = { solana: { complete: false, scanStartedAt: "2026-11-06T03:00:00.000Z" } };
    expect(asOfFromSolanaScan(cutoffs, partial, ["solana"], "2026-11-06")).toEqual({ date: null, blocks: {}, settled: false, incomplete: ["solana"] });
    expect(asOfFromSolanaScan(cutoffs, { solana: { complete: true } }, ["solana"], "2026-11-06").date).toBeNull();
    expect(asOfFromSolanaScan(cutoffs, {}, ["solana"], "2026-11-06").incomplete).toEqual(["solana"]);
  });

  it("asOf stamps D-1 and cutoff[today]-1 per chain", () => {
    expect(asOfFromCutoffs({ base: { "2026-11-06": 168 }, ethereum: { "2026-11-05": 9 } }, "2026-11-06"))
      .toEqual({ date: "2026-11-05", blocks: { base: 167 }, settled: true });
  });

  it("flowFeedAsOf: EVM chains stamp from reached blocks; a Solana-only feed stamps from the scan state", () => {
    const cutoffs = { base: { "2026-11-05": 100, "2026-11-06": 168 }, solana: { "2026-11-05": 100, "2026-11-06": 200 } };
    expect(flowFeedAsOf(cutoffs, { reached: { base: 167 } }, "2026-11-06")).toEqual({ date: "2026-11-05", blocks: { base: 167 }, settled: true });
    const done = { solana: { complete: true, scanStartedAt: "2026-11-06T03:00:00.000Z" } };
    expect(flowFeedAsOf(cutoffs, { reached: {}, scanState: done, solanaKeys: ["solana"] }, "2026-11-06"))
      .toEqual({ date: "2026-11-05", blocks: { solana: 199 }, settled: true });
    const partial = { solana: { complete: false, scanStartedAt: "2026-11-06T03:00:00.000Z" } };
    expect(flowFeedAsOf(cutoffs, { reached: {}, scanState: partial, solanaKeys: ["solana"] }, "2026-11-06"))
      .toEqual({ date: null, blocks: {}, settled: false, incomplete: ["solana"] });
    expect(flowFeedAsOf(cutoffs, { reached: {}, scanState: null, solanaKeys: ["solana"] }, "2026-11-06").date).toBeNull();
  });

  it("asOfFromReached stamps the block and last complete day actually reached (capped backlog)", async () => {
    const io = memIo();
    const w = await cutoffScanWindow({ project: proj, chain: "base", from: 0, latest: 200, maxBlocks: 100, today: "2026-11-06", getBlockTimestamp: chainTs, io, root: "/r" });
    expect(w.end).toBe(99);
    // block 99 is mid 2026-11-05 -> last complete day is 2026-11-04
    expect(asOfFromReached(w.cutoffs, { base: w.end }, "2026-11-06")).toEqual({ date: "2026-11-04", blocks: { base: 99 }, settled: true });
    expect(asOfFromReached(w.cutoffs, { base: 167 }, "2026-11-06")).toEqual({ date: "2026-11-05", blocks: { base: 167 }, settled: true });
    expect(asOfFromReached(w.cutoffs, { base: 199 }, "2026-11-06").blocks.base).toBe(167);
    expect(lastCompleteDate(w.cutoffs.base, 23)).toBe("2026-11-04");
  });

  it("requireDayBounds throws on a missing middle or end cutoff", () => {
    const c = { "2026-11-04": 0, "2026-11-05": 24, "2026-11-06": 168, "2026-11-07": 300 };
    expect(requireDayBounds("base", c, ["2026-11-04", "2026-11-05", "2026-11-06"])).toEqual({
      bounds: [{ block: 0, date: "2026-11-04" }, { block: 24, date: "2026-11-05" }, { block: 168, date: "2026-11-06" }],
      endBoundary: 300,
    });
    const { "2026-11-05": _mid, ...noMiddle } = c;
    expect(() => requireDayBounds("base", noMiddle, ["2026-11-04", "2026-11-05", "2026-11-06"])).toThrow(/2026-11-05/);
    const { "2026-11-07": _end, ...noEnd } = c;
    expect(() => requireDayBounds("base", noEnd, ["2026-11-04", "2026-11-05", "2026-11-06"])).toThrow(/2026-11-07/);
  });

  it("end-of-day map round-trips with cutoffsFromEndOfDayMap; merge keeps existing", () => {
    const legacy = { "2026-11-04": { ethereum: 99, base: 500 } };
    const c = cutoffsFromEndOfDayMap(legacy);
    expect(endOfDayMapFromCutoffs(c, ["2026-11-04", "2026-11-05"])).toEqual(legacy);
    expect(mergeCutoffMaps({ base: { "2026-11-05": 1 } }, { base: { "2026-11-05": 2, "2026-11-06": 3 } }))
      .toEqual({ base: { "2026-11-05": 1, "2026-11-06": 3 } });
    expect(datesFromTo("2026-10-31", "2026-11-02")).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(dateOfBlock({ "2026-11-05": 10 }, 9)).toBeNull();
    expect(settledEndBlock({}, "2026-11-06")).toBeNull();
  });
});
