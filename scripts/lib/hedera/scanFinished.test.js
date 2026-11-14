import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hederaAdapter } from "./adapter.js";
import { HEDERA_FINISHED_ATTEMPTS, HEDERA_RESUME_PINNED_MAX_DRIFT_SECONDS, HEDERA_RESUME_UNPINNED_MAX_AGE_SECONDS, resumeStaleReason, scanBalanceSnapshot } from "./scan.js";
import { createMirrorClient } from "./mirror.js";
import { createMockMirror } from "./mockMirror.js";
import { loadResumable, keepsFinishedScan, settlePartial } from "../partialCheckpoint.js";

const BASE = "https://mirror.test/api/v1";
const HBAR = 100_000_000n;
const TS = "1794165040.107980111";
const NEXT_TS = "1794165940.200000002";
const chain = { key: "hedera", vm: "hedera", mirrorUrl: BASE, rangeWidth: 100 };
const quiet = { log() {}, warn() {} };
const opts = (mock, extra = {}) => ({ fetch: mock.fetch, sleep: async () => {}, nowMs: () => 0, logger: quiet, ...extra });
const acct = (num, hbar) => ({ num, balance: BigInt(hbar) * HBAR, tokens: [] });

function population(bump = 0) {
  const accounts = [];
  for (let n = 1; n <= 450; n += 1) accounts.push(acct(n, n % 7 === 0 ? 0 : 5 + n + (n === 1 ? bump : 0)));
  return { accounts, contracts: [10, 11, 200] };
}

const pagingCalls = (mock) => mock.balanceCalls().filter((c) => c.params.getAll("account.id").length > 0);
const pick = (scan) => ({ ...scan.checkpointData, scannedAt: undefined });

/** Scans once and returns { scan, finished } where finished is the last (complete) state reported. */
async function scanAndKeep(extra = {}, pop = population(), snapshotTimestamp = TS) {
  const states = [];
  const scan = await hederaAdapter.scanChain(chain, opts(createMockMirror({ ...pop, snapshotTimestamp }), { onProgress: (s) => states.push(JSON.parse(JSON.stringify(s))), ...extra }));
  return { scan, states, finished: states.at(-1) };
}

describe("hedera finished scan state", () => {
  it("is marked complete only when the last range lands", async () => {
    const { states, finished } = await scanAndKeep();
    expect(finished.complete).toBe(true);
    expect(states.filter((s) => s.complete)).toHaveLength(1);
    expect(finished.open).toEqual({});
    expect(hederaAdapter.resumeProblem(chain, finished)).toBeNull();
    expect(keepsFinishedScan(hederaAdapter)).toBe(true);
  });

  it("serves a finished state for the same resolved stamp with no paging and the same result", async () => {
    const { scan: fresh, finished } = await scanAndKeep();
    const before = JSON.stringify(finished);
    const mock = createMockMirror(population());
    const reused = await hederaAdapter.scanChain(chain, opts(mock, { resume: finished }));
    expect(pagingCalls(mock)).toHaveLength(0);
    expect(JSON.stringify(finished)).toBe(before);
    expect([...reused.balances]).toEqual([...fresh.balances]);
    expect(pick(reused)).toEqual(pick(fresh));
  });

  it("returns identical rows, allRaw, nonzero, maxId and timestamp from the scan layer", async () => {
    const { scanBalanceSnapshot } = await import("./scan.js");
    const states = [];
    const mockA = createMockMirror(population());
    const client = (await import("./mirror.js")).createMirrorClient({ baseUrl: BASE, fetch: mockA.fetch, sleep: async () => {}, now: () => 0 });
    const fresh = await scanBalanceSnapshot(client, { floor: HBAR, width: 100, onProgress: (s) => states.push(JSON.parse(JSON.stringify(s))) });
    const mockB = createMockMirror(population());
    const clientB = (await import("./mirror.js")).createMirrorClient({ baseUrl: BASE, fetch: mockB.fetch, sleep: async () => {}, now: () => 0 });
    const reused = await scanBalanceSnapshot(clientB, { floor: HBAR, width: 100, resume: states.at(-1) });
    expect(reused.finishedState).toBe("reused");
    expect(pagingCalls(mockB)).toHaveLength(0);
    for (const key of ["rows", "allRaw", "nonzero", "maxId", "timestamp"]) expect(reused[key]).toEqual(fresh[key]);
  });

  it("scans afresh when the run resolves another stamp, and never serves the old rows", async () => {
    const { finished } = await scanAndKeep();
    const mock = createMockMirror({ ...population(1000), snapshotTimestamp: NEXT_TS });
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { resume: finished }));
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEXT_TS);
    expect(scan.balances.get("0.0.1")).toBe(6 + 1000);
    expect(pagingCalls(mock).length).toBeGreaterThan(0);
    expect(pagingCalls(mock).every((c) => c.params.get("timestamp") === NEXT_TS)).toBe(true);
  });

  it("scans afresh for an unpinned run that resolves a newer stamp than the finished one", async () => {
    const { finished } = await scanAndKeep();
    const states = [];
    const mock = createMockMirror({ ...population(), snapshotTimestamp: NEXT_TS });
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { resume: finished, onProgress: (s) => states.push(JSON.parse(JSON.stringify(s))) }));
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEXT_TS);
    expect(states.at(-1)).toMatchObject({ timestamp: NEXT_TS, complete: true });
  });

  it("drops a 72 h old in-progress state on an unpinned run: the fresh stamp is published and every range is paged again", async () => {
    const { states } = await scanAndKeep();
    const inProgress = states.find((s) => Object.keys(s.ranges).length > 0);
    expect(inProgress.complete).toBeUndefined();
    const NEWEST = `${Number(TS.split(".")[0]) + 72 * 3600}.200000002`; // the newest snapshot, 72 h after the saved one
    const freshMock = createMockMirror({ ...population(), snapshotTimestamp: NEWEST });
    await hederaAdapter.scanChain(chain, opts(freshMock));
    const warn = [];
    const progress = [];
    const mock = createMockMirror({ ...population(), snapshotTimestamp: NEWEST });
    const scan = await hederaAdapter.scanChain(
      chain,
      opts(mock, { resume: inProgress, logger: { log() {}, warn: (m) => warn.push(m) }, onProgress: (s) => progress.push(JSON.parse(JSON.stringify(s))) }),
    );
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEWEST);
    expect(pagingCalls(mock)).toHaveLength(pagingCalls(freshMock).length);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatch(/72\.0h older than the newest snapshot .* \(limit 6h\), and no pin is available/);
    expect(progress[0].timestamp).toBe(NEWEST);
  });

  it("rescans the same stamp when a reused state does not add up to total supply", async () => {
    const { scan: fresh, finished } = await scanAndKeep();
    const bad = JSON.parse(JSON.stringify(finished));
    bad.totals[0].allRaw = String(BigInt(bad.totals[0].allRaw) + 1n);
    const mock = createMockMirror(population());
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { resume: bad }));
    expect(pagingCalls(mock).length).toBeGreaterThan(0);
    expect([...scan.balances]).toEqual([...fresh.balances]);
  });

});

describe("hedera finished state validation", () => {
  it("names a problem for a finished state that is not whole", async () => {
    const { finished } = await scanAndKeep();
    const noRange = { ...finished, ranges: Object.fromEntries(Object.entries(finished.ranges).slice(1)) };
    expect(hederaAdapter.resumeProblem(chain, noRange)).toMatch(/malformed/);
    expect(hederaAdapter.resumeProblem(chain, { ...finished, complete: false })).toMatch(/malformed/);
    expect(hederaAdapter.resumeProblem(chain, { ...finished, open: { 0: { op: "gt", from: 1, previous: 1, count: 0, rows: [], allRaw: "0", nonzero: 0 } } })).toMatch(/malformed|range/);
    expect(hederaAdapter.resumeProblem(chain, null)).toMatch(/malformed/);
    expect(hederaAdapter.resumeProblem(chain, "x")).toMatch(/malformed/);
  });
});

describe("hedera saved state on disk (loadResumable): a bad file means a fresh scan, never a throw", () => {
  const withFile = async (content, fn) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hedera-finished-"));
    const file = path.join(dir, "holders-partial-hedera.json");
    if (content !== null) await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
    try {
      return await fn(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
  const exists = (file) => fs.access(file).then(() => true, () => false);
  const warnings = () => {
    const seen = [];
    return { seen, warn: (m) => seen.push(m), log() {} };
  };

  it("returns the saved finished state when it fits", async () => {
    const { finished } = await scanAndKeep();
    await withFile(finished, async (file) => {
      expect(await loadResumable(hederaAdapter, chain, file, warnings())).toEqual(finished);
      expect(await exists(file)).toBe(true);
    });
  });

  it("a different floor or range width drops the file and scans fresh", async () => {
    const { finished } = await scanAndKeep();
    for (const other of [{ ...chain, holderFloorTinybar: "200000000" }, { ...chain, rangeWidth: 50 }]) {
      await withFile(finished, async (file) => {
        const log = warnings();
        const resume = await loadResumable(hederaAdapter, other, file, log);
        expect(resume).toBeNull();
        expect(log.seen[0]).toMatch(/floor|range width/);
        expect(await exists(file)).toBe(false);
        const mock = createMockMirror(population());
        const scan = await hederaAdapter.scanChain(other, opts(mock, { resume }));
        expect(pagingCalls(mock).length).toBeGreaterThan(0);
        expect(scan.checkpointData.snapshotTimestamp).toBe(TS);
      });
    }
  });

  it.each([
    ["an old-version state", (s) => ({ ...s, version: 1 })],
    ["a state missing its ranges", (s) => ({ ...s, ranges: undefined })],
    ["truncated JSON", (s) => JSON.stringify(s).slice(0, 60)],
    ["a JSON array", () => "[]"],
    ["a JSON string", () => '"nope"'],
  ])("%s: warns, removes the file, scans fresh", async (_name, damage) => {
    const { finished } = await scanAndKeep();
    await withFile(damage(finished), async (file) => {
      const log = warnings();
      const resume = await loadResumable(hederaAdapter, chain, file, log);
      expect(resume).toBeNull();
      expect(log.seen).toHaveLength(1);
      expect(await exists(file)).toBe(false);
      const scan = await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { resume }));
      expect(scan.checkpointData.snapshotTimestamp).toBe(TS);
    });
  });

  it("a missing file is no warning and no resume", async () => {
    await withFile(null, async (file) => {
      const log = warnings();
      expect(await loadResumable(hederaAdapter, chain, file, log)).toBeNull();
      expect(log.seen).toHaveLength(0);
    });
  });

  it("an opted-in adapter's finished state survives settlePartial; another adapter's file is removed", async () => {
    const { finished } = await scanAndKeep();
    await withFile(finished, async (file) => {
      expect(await settlePartial(hederaAdapter, file)).toBe(false);
      expect(await exists(file)).toBe(true);
      expect(await settlePartial({ resumeProblem: () => null }, file)).toBe(true);
      expect(await exists(file)).toBe(false);
    });
  });
});

describe("hedera finished state across clusters with different snapshot grids", () => {
  const blockTime = (n) => 1794165000 + n * 2;
  // Cluster a holds S = 1794165040.107980111 and, a day later, S+900; cluster b is on another grid.
  const gridA = ["1794164140.107980111", TS, "1794165940.107980111"];
  const gridB = ["1794164950.500000001", "1794165850.500000001"];
  const HEAD = "1794166294.000000001";
  const mirror = (extra = {}, pop = population()) => createMockMirror({ ...pop, clusters: { a: gridA, b: gridB }, headTimestamp: HEAD, blockTime, blockCount: 1000, ...extra });
  const descCalls = (mock) => mock.balanceCalls().filter((c) => c.params.get("order") === "desc" && c.params.getAll("account.id").length === 0);
  const sleeper = () => {
    const sleeps = [];
    return { sleeps, sleep: async (ms) => void sleeps.push(ms) };
  };
  const keepAt = async (pinBlock) => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(mirror(), { pinBlock, onProgress: (s) => states.push(JSON.parse(JSON.stringify(s))) }));
    return states.at(-1);
  };

  it("(a) reuses S when the first answer comes from the other cluster and a later one from the holder", async () => {
    const finished = await keepAt(100); // block 100 ends 1794165202: a resolves S, b resolves 1794164950.5
    expect(finished.timestamp).toBe(TS);
    const probe = mirror();
    await hederaAdapter.scanChain(chain, opts(probe, { pinBlock: 100 }));
    const first = probe.calls.findIndex((c) => c.path === "/balances");
    const mock = mirror({ route: (i) => (i >= first && i < first + 2 ? "b" : "a") }); // attempt 1 is answered wholly by b
    const { sleep } = sleeper();
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: 100, resume: finished, sleep }));
    expect(scan.checkpointData.snapshotTimestamp).toBe(TS);
    expect(pagingCalls(mock)).toHaveLength(0);
    expect(descCalls(mock)).toHaveLength(4); // two attempts, two requests each
  });

  it("(b)(d) next day: every cluster resolves a newer stamp, so it misses after the bounded attempts and scans afresh", async () => {
    const finished = await keepAt(100);
    const mock = mirror({}, population(1000));
    const { sleep } = sleeper();
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: 800, resume: finished, sleep }));
    expect(scan.checkpointData.snapshotTimestamp).toBe(gridA.at(-1));
    expect(scan.balances.get("0.0.1")).toBe(6 + 1000);
    expect(pagingCalls(mock).length).toBeGreaterThan(0);
    expect(pagingCalls(mock).every((c) => c.params.get("timestamp") === gridA.at(-1))).toBe(true);
    expect(descCalls(mock)).toHaveLength(2 * HEDERA_FINISHED_ATTEMPTS);
  });

  it("(c) an unpinned run resolves once: newest wins, no retries", async () => {
    const { finished } = { finished: await keepAt(100) };
    const mock = mirror({}, population(1000));
    const { sleep } = sleeper();
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { resume: finished, sleep }));
    expect(scan.checkpointData.snapshotTimestamp).toBe(gridA.at(-1));
    expect(descCalls(mock)).toHaveLength(3); // head, the stamp it resolves to, and the check that the stamp answers itself
  });
});

describe("resumeStaleReason", () => {
  const stamp = "1794165040.000000000";
  const secs = Number(stamp.split(".")[0]);
  const at = (offset) => `${secs + offset}.000000000`;
  const live = { timestamp: stamp };

  it("pins the limits", () => {
    expect(HEDERA_RESUME_PINNED_MAX_DRIFT_SECONDS).toBe(1800);
    expect(HEDERA_RESUME_UNPINNED_MAX_AGE_SECONDS).toBe(21600);
  });

  it("is not about finished or missing states", () => {
    expect(resumeStaleReason({ ...live, complete: true }, { freshStamp: at(999_999), pinned: true })).toBeNull();
    expect(resumeStaleReason({ ...live, complete: true }, { freshStamp: at(999_999), pinned: false })).toBeNull();
    expect(resumeStaleReason(null, { freshStamp: at(10), pinned: true })).toBeNull();
    expect(resumeStaleReason(undefined, { freshStamp: at(10), pinned: false })).toBeNull();
  });

  it("pinned: resumable up to and including 1800 s older than the fresh snapshot, stale beyond", () => {
    expect(resumeStaleReason(live, { freshStamp: at(60), pinned: true })).toBeNull();
    expect(resumeStaleReason(live, { freshStamp: at(1800), pinned: true })).toBeNull();
    expect(resumeStaleReason(live, { freshStamp: at(1801), pinned: true })).toBe(`1801s older than the snapshot a fresh scan would use, ${at(1801)} (limit 1800s)`);
    expect(resumeStaleReason(live, { freshStamp: at(86_400), pinned: true })).toMatch(/^86400s older than the snapshot a fresh scan would use, .* \(limit 1800s\)$/);
  });

  it("pinned: a state later than the fresh snapshot (the other cluster's grid) is resumable", () => {
    expect(resumeStaleReason(live, { freshStamp: at(-500), pinned: true })).toBeNull();
  });

  it("unpinned: resumable up to and including 6 h older than the newest snapshot, stale beyond", () => {
    expect(resumeStaleReason(live, { freshStamp: at(5 * 3600), pinned: false })).toBeNull();
    expect(resumeStaleReason(live, { freshStamp: at(6 * 3600), pinned: false })).toBeNull();
    expect(resumeStaleReason(live, { freshStamp: at(6 * 3600 + 1), pinned: false })).toMatch(/^6\.0h older/);
    expect(resumeStaleReason(live, { freshStamp: at(7 * 3600), pinned: false })).toBe(`7.0h older than the newest snapshot ${at(7 * 3600)} (limit 6h), and no pin is available`);
  });

  it("(2e) is exact to the nanosecond, with fractions on both sides", () => {
    const saved = (t) => ({ timestamp: t });
    // pinned: 1800 s exactly is resumable, 1 ns more is stale (also across a second boundary)
    expect(resumeStaleReason(saved("1794165040.107980111"), { freshStamp: "1794166840.107980111", pinned: true })).toBeNull();
    expect(resumeStaleReason(saved("1794165040.107980111"), { freshStamp: "1794166840.107980112", pinned: true })).toMatch(/^1800s older/);
    expect(resumeStaleReason(saved("1794165040.999999999"), { freshStamp: "1794166840.999999999", pinned: true })).toBeNull();
    expect(resumeStaleReason(saved("1794165040.999999999"), { freshStamp: "1794166841.000000000", pinned: true })).toMatch(/^1800s older/);
    // unpinned: 6 h exactly is resumable, 1 ns more is stale
    expect(resumeStaleReason(saved("1794165040.250000000"), { freshStamp: "1794186640.250000000", pinned: false })).toBeNull();
    expect(resumeStaleReason(saved("1794165040.250000000"), { freshStamp: "1794186640.250000001", pinned: false })).toMatch(/^6\.0h older/);
  });

  it("an unreadable stamp is not its business: null, never a throw", () => {
    for (const timestamp of ["abc", "", "12.x", undefined]) {
      expect(resumeStaleReason({ timestamp }, { freshStamp: at(86_400), pinned: true })).toBeNull();
      expect(resumeStaleReason({ timestamp }, { freshStamp: at(86_400), pinned: false })).toBeNull();
    }
    expect(resumeStaleReason(live, { freshStamp: "nope", pinned: true })).toBeNull();
  });
});

describe("hedera in-progress state age rule at the adapter", () => {
  const blockTime = (n) => 1794165000 + n * 2;
  const PIN_BLOCK = 99; // ends blockTime(100)
  const PIN_END = "1794165200.000000000";
  const secs = (s) => Number(s.split(".")[0]);
  const shift = (s, by) => `${secs(s) + by}.${s.split(".")[1]}`;
  const NEAR = shift(PIN_END, -60);
  const mirror = (stamp, extra = {}) => createMockMirror({ ...population(), snapshotTimestamp: stamp, blockTime, blockCount: 1000, ...extra });
  const clone = (s) => JSON.parse(JSON.stringify(s));
  const catcher = () => {
    const warn = [];
    return { warn, logger: { log() {}, warn: (m) => warn.push(m) } };
  };
  /** First in-progress state (some ranges done, not complete) of a scan that ran against `mock`. */
  async function partialOf(mock, extra = {}) {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(mock, { onProgress: (s) => states.push(clone(s)), ...extra }));
    const state = states.find((s) => !s.complete && Object.keys(s.ranges).length > 0);
    expect(state).toBeDefined();
    return state;
  }
  const freshPaging = async (stamp, extra = {}) => {
    const mock = mirror(stamp, extra.mirror);
    await hederaAdapter.scanChain(chain, opts(mock, extra.scan));
    return pagingCalls(mock).length;
  };

  const descCalls = (mock) => mock.balanceCalls().filter((c) => c.params.get("order") === "desc" && c.params.getAll("account.id").length === 0);

  it("(b) pinned, mirror lag: the fresh snapshot is 40 min before the pin end; an interrupted scan still resumes in the same night", async () => {
    const LAG = shift(PIN_END, -2400); // newest stamp at or before the pin end, more than 1800 s behind it
    const lagged = () => mirror(LAG, { clusters: { a: [LAG] } });
    const saved = [];
    const first = opts(lagged(), {
      pinBlock: PIN_BLOCK,
      onProgress: (s) => {
        saved.push(clone(s));
        if (Object.keys(s.ranges).length > 0) throw new Error("interrupted");
      },
    });
    await expect(hederaAdapter.scanChain(chain, first)).rejects.toThrow(/interrupted/);
    const resume = saved.at(-1);
    expect(resume.timestamp).toBe(LAG);
    expect(Object.keys(resume.ranges).length).toBeGreaterThan(0);
    const log = catcher();
    const mock = lagged();
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: PIN_BLOCK, resume, ...log }));
    expect(log.warn).toHaveLength(0);
    expect(scan.checkpointData.snapshotTimestamp).toBe(LAG);
    expect(pagingCalls(mock).length).toBeLessThan(await freshPaging(LAG, { mirror: { clusters: { a: [LAG] } }, scan: { pinBlock: PIN_BLOCK } }));
  });

  it("(b2) pinned: a state at the fresh stamp is resumed, its done ranges are not paged again", async () => {
    const resume = await partialOf(mirror(NEAR));
    const log = catcher();
    const mock = mirror(NEAR);
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: PIN_BLOCK, resume, ...log }));
    expect(log.warn).toHaveLength(0);
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEAR);
    expect(scan.checkpointData.settledThrough).toBe(PIN_END);
    expect(pagingCalls(mock).length).toBeLessThan(await freshPaging(NEAR, { scan: { pinBlock: PIN_BLOCK } }));
  });

  it("(c)(g) pinned, previous night: a state 24 h older than the fresh stamp is dropped with one warning before paging, and the stamp is resolved once", async () => {
    const old = shift(NEAR, -86_400);
    const resume = await partialOf(mirror(old));
    const order = [];
    const log = { warn: [], logger: { log() {}, warn: (m) => (log.warn.push(m), order.push("warn")) } };
    const progress = [];
    const mock = mirror(NEAR);
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: PIN_BLOCK, resume, onProgress: (s) => (progress.push(clone(s)), order.push("progress")), ...log }));
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toBe(`  hedera: saved in-progress scan state at ${old} is 86400s older than the snapshot a fresh scan would use, ${NEAR} (limit 1800s); starting a fresh scan.`);
    expect(order[0]).toBe("warn");
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEAR);
    expect(pagingCalls(mock)).toHaveLength(await freshPaging(NEAR, { scan: { pinBlock: PIN_BLOCK } }));
    expect(progress[0].timestamp).toBe(NEAR);
    expect(progress.every((s) => s.timestamp === NEAR)).toBe(true);
    const baseline = mirror(NEAR);
    await hederaAdapter.scanChain(chain, opts(baseline, { pinBlock: PIN_BLOCK }));
    expect(descCalls(mock)).toHaveLength(descCalls(baseline).length);
  });

  it("(d) pinned, true cross-cluster: saved by cluster b, resolved afresh by cluster a 790 s later, is resumed", async () => {
    const stampA = shift(PIN_END, -60);
    const stampB = "1794164350.500000001";
    const grid = { clusters: { a: [stampA], b: [stampB] } };
    const resume = await partialOf(mirror(stampA, { ...grid, route: () => "b" }), { pinBlock: PIN_BLOCK });
    expect(resume.timestamp).toBe(stampB);
    const probe = mirror(stampA, grid);
    await hederaAdapter.scanChain(chain, opts(probe, { pinBlock: PIN_BLOCK }));
    const first = probe.calls.findIndex((c) => c.path === "/balances"); // the fresh resolution: this call and its self-check
    const log = catcher();
    const mock = mirror(stampA, { ...grid, route: (i) => (i >= first && i < first + 2 ? "a" : "b") });
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: PIN_BLOCK, resume, ...log }));
    const resolutions = mock.calls.filter((c) => c.path === "/balances" && c.params.get("order") === "desc" && c.params.getAll("account.id").length === 0);
    expect(resolutions[0].cluster).toBe("a");
    expect(resolutions.some((c) => c.cluster === "b")).toBe(true);
    expect(log.warn).toHaveLength(0);
    expect(scan.checkpointData.snapshotTimestamp).toBe(stampB);
    expect(pagingCalls(mock).every((c) => c.params.get("timestamp") === stampB)).toBe(true);
    expect(pagingCalls(mock).length).toBeLessThan(await freshPaging(stampA, { mirror: { ...grid }, scan: { pinBlock: PIN_BLOCK } }));
  });

  it("(e) same-run retry: an interrupted pinned scan resumes in a second call with the same pin", async () => {
    const saved = [];
    const first = opts(mirror(NEAR), {
      pinBlock: PIN_BLOCK,
      onProgress: (s) => {
        saved.push(clone(s));
        if (Object.keys(s.ranges).length > 0) throw new Error("interrupted");
      },
    });
    await expect(hederaAdapter.scanChain(chain, first)).rejects.toThrow(/interrupted/);
    const resume = saved.at(-1);
    expect(Object.keys(resume.ranges).length).toBeGreaterThan(0);
    const log = catcher();
    const mock = mirror(NEAR);
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: PIN_BLOCK, resume, ...log }));
    expect(log.warn).toHaveLength(0);
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEAR);
    expect(pagingCalls(mock).length).toBeLessThan(await freshPaging(NEAR, { scan: { pinBlock: PIN_BLOCK } }));
  });

  it("(f) unpinned: a state 5 h older than the newest snapshot is resumed (no clock involved)", async () => {
    const old = shift(NEAR, -5 * 3600);
    const grid = { clusters: { a: [old, NEAR] } }; // one cluster that holds both snapshots
    const resume = await partialOf(mirror(old, { clusters: { a: [old] } }));
    expect(resume.timestamp).toBe(old);
    const log = catcher();
    const mock = mirror(NEAR, grid);
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { resume, nowMs: () => 0, ...log }));
    expect(log.warn).toHaveLength(0);
    expect(scan.checkpointData.snapshotTimestamp).toBe(old);
    expect(pagingCalls(mock).length).toBeLessThan(await freshPaging(NEAR, { mirror: grid }));
  });

  it("(f)(g) unpinned: a state 7 h older is dropped with the unpinned warning; fresh stamp published, first progress write carries it, one resolution", async () => {
    const old = shift(NEAR, -7 * 3600);
    const resume = await partialOf(mirror(old));
    const log = catcher();
    const progress = [];
    const mock = mirror(NEAR);
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { resume, onProgress: (s) => progress.push(clone(s)), ...log }));
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toBe(`  hedera: saved in-progress scan state at ${old} is 7.0h older than the newest snapshot ${NEAR} (limit 6h), and no pin is available; starting a fresh scan.`);
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEAR);
    expect(pagingCalls(mock)).toHaveLength(await freshPaging(NEAR));
    expect(progress[0].timestamp).toBe(NEAR);
    const baseline = mirror(NEAR);
    await hederaAdapter.scanChain(chain, opts(baseline));
    expect(descCalls(mock)).toHaveLength(descCalls(baseline).length);
    expect(descCalls(mock)).toHaveLength(3); // head, the stamp it resolves to, its self-check
  });

  it("(2a) a dropped state's maxId is not carried over: the scan covers the fresh maxId and publishes the accounts beyond the old one", async () => {
    const old = shift(NEAR, -7 * 3600);
    const small = { accounts: population().accounts.slice(0, 250), contracts: [10, 11, 200], snapshotTimestamp: old };
    const resume = await partialOf(createMockMirror(small));
    expect(resume.maxId).toBe(250);
    const progress = [];
    const mock = mirror(NEAR);
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { resume, onProgress: (s) => progress.push(clone(s)) }));
    expect(progress[0].maxId).toBe(450);
    expect(scan.balances.get("0.0.449")).toBe(5 + 449);
    expect(scan.balances.get("0.0.400")).toBe(5 + 400);
    expect(scan.checkpointData.snapshotTimestamp).toBe(NEAR);
  });

  it("(2b) pinned: a saved stamp LATER than the fresh one (other cluster's grid), not after the pin end, is resumed through scanChain", async () => {
    const fresh = shift(PIN_END, -600);
    const saved = shift(PIN_END, -300);
    const grid = { clusters: { a: [fresh], b: [saved] } };
    const resume = await partialOf(mirror(fresh, { ...grid, route: () => "b" }), { pinBlock: PIN_BLOCK });
    expect(resume.timestamp).toBe(saved);
    const probe = mirror(fresh, grid);
    await hederaAdapter.scanChain(chain, opts(probe, { pinBlock: PIN_BLOCK }));
    const first = probe.calls.findIndex((c) => c.path === "/balances");
    const log = catcher();
    const mock = mirror(fresh, { ...grid, route: (i) => (i >= first && i < first + 2 ? "a" : "b") });
    const scan = await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: PIN_BLOCK, resume, ...log }));
    expect(log.warn).toHaveLength(0);
    expect(scan.checkpointData.snapshotTimestamp).toBe(saved);
    expect(descCalls(mock).some((c) => c.params.get("timestamp") === `lte:${PIN_END}` && c.cluster === "a")).toBe(true);
  });

  it("(2c) a resumable in-progress state costs exactly one more resolution request than a no-state run, pinned and unpinned", async () => {
    const countOf = async (extra, resume) => {
      const mock = mirror(NEAR);
      await hederaAdapter.scanChain(chain, opts(mock, { ...extra, ...(resume ? { resume } : {}) }));
      return descCalls(mock).length;
    };
    const resume = await partialOf(mirror(NEAR));
    const pinned = { pinBlock: PIN_BLOCK };
    expect(await countOf(pinned, resume)).toBe((await countOf(pinned, null)) + 1);
    expect(await countOf({}, resume)).toBe((await countOf({}, null)) + 1);
    expect(await countOf({}, null)).toBe(3);
    expect(await countOf(pinned, null)).toBe(2);
  });

  it("(2d) the drop warning comes before the first balance-page request", async () => {
    const old = shift(NEAR, -86_400);
    const resume = await partialOf(mirror(old));
    const order = [];
    const mock = mirror(NEAR);
    const fetch = async (url, init) => (order.push(`req ${url}`), mock.fetch(url, init));
    const logger = { log() {}, warn: (m) => order.push(`warn ${m}`) };
    await hederaAdapter.scanChain(chain, opts(mock, { pinBlock: PIN_BLOCK, resume, fetch, logger }));
    const warnAt = order.findIndex((e) => e.startsWith("warn"));
    const isPage = (e) => e.startsWith("req ") && e.includes("/balances") && e.includes("account.id");
    const pageAt = order.findIndex(isPage);
    expect(warnAt).toBeGreaterThan(0); // after the fresh resolution request
    expect(pageAt).toBeGreaterThan(warnAt);
    expect(order.slice(0, warnAt).some(isPage)).toBe(false);
    expect(order[pageAt]).toContain(`timestamp=${NEAR}`);
  });

  it("(2f) scanBalanceSnapshot reports resumeDropped: the reason on a drop, null on a resume and on a no-state run", async () => {
    const clientOf = (mock) => createMirrorClient({ baseUrl: BASE, fetch: mock.fetch, sleep: async () => {}, now: () => 0 });
    const scanWith = (mock, extra = {}) => scanBalanceSnapshot(clientOf(mock), { floor: HBAR, width: 100, ...extra });
    const dropped = shift(NEAR, -7 * 3600);
    const resumable = shift(NEAR, -5 * 3600);
    const grid = { clusters: { a: [dropped, resumable, NEAR] } };
    const saved = async (stamp) => partialOf(mirror(stamp, { clusters: { a: [stamp] } }));
    expect((await scanWith(mirror(NEAR, grid))).resumeDropped).toBeNull();
    expect((await scanWith(mirror(NEAR, grid), { resume: await saved(resumable) })).resumeDropped).toBeNull();
    const reasons = [];
    const drop = await scanWith(mirror(NEAR, grid), { resume: await saved(dropped), onResumeDropped: (r, s) => reasons.push([r, s]) });
    expect(drop.resumeDropped).toBe(`7.0h older than the newest snapshot ${NEAR} (limit 6h), and no pin is available`);
    expect(drop.timestamp).toBe(NEAR);
    expect(reasons).toEqual([[drop.resumeDropped, { savedStamp: dropped, freshStamp: NEAR }]]);
  });
});

describe("hedera finished state with the same stamp but another highest id", () => {
  it("is discarded: the mirror's rows are served, not the saved ones", async () => {
    const { scanBalanceSnapshot } = await import("./scan.js");
    const { createMirrorClient } = await import("./mirror.js");
    const clientOf = (mock) => createMirrorClient({ baseUrl: BASE, fetch: mock.fetch, sleep: async () => {}, now: () => 0 });
    const states = [];
    await scanBalanceSnapshot(clientOf(createMockMirror(population())), { floor: HBAR, width: 100, onProgress: (s) => states.push(JSON.parse(JSON.stringify(s))) });
    const saved = states.at(-1);
    expect(saved).toMatchObject({ complete: true, timestamp: TS, maxId: 450 });
    const grown = population(1000);
    grown.accounts.push(acct(460, 9)); // same stamp, highest id 460, still inside the same ranges
    const mock = createMockMirror(grown);
    const scan = await scanBalanceSnapshot(clientOf(mock), { floor: HBAR, width: 100, resume: saved });
    expect(scan.finishedState).toBe("discarded");
    expect(scan.timestamp).toBe(TS);
    expect(scan.maxId).toBe(460);
    expect(pagingCalls(mock).length).toBeGreaterThan(0);
    expect(scan.rows.find(([id]) => id === 460)).toEqual([460, String(9n * HBAR)]);
    expect(scan.rows.find(([id]) => id === 1)).toEqual([1, String(BigInt(6 + 1000) * HBAR)]);
  });
});
