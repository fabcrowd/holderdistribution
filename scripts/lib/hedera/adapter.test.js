import { describe, expect, it } from "vitest";
import { hederaAdapter, HEDERA_HOLDER_FLOOR_TINYBAR } from "./adapter.js";
import { createMockMirror } from "./mockMirror.js";

const BASE = "https://mirror.test/api/v1";
const HBAR = 100_000_000n;
const TS = "1794165040.107980111";
const chain = { key: "hedera", vm: "hedera", mirrorUrl: BASE, rangeWidth: 100 };
const quiet = { log() {}, warn() {} };
const opts = (mock, extra = {}) => ({ fetch: mock.fetch, sleep: async () => {}, nowMs: () => 0, logger: quiet, ...extra });
const acct = (num, hbar, tokens = []) => ({ num, balance: BigInt(hbar) * HBAR, tokens });
const CONTRACTS = [10, 11, 200, 454, 460];

function population() {
  const accounts = [];
  for (let n = 1; n <= 450; n += 1) accounts.push(acct(n, n % 7 === 0 ? 0 : 5 + n));
  accounts.push({ num: 451, balance: HBAR - 1n }); // one tinybar under the floor
  accounts.push({ num: 452, balance: HBAR }); // exactly the floor
  accounts.push({ num: 453, balance: 0n, tokens: [{ token_id: "0.0.9", balance: 123 }] }); // HTS only
  accounts.push({ num: 454, balance: 320_000_000_000_000_001n }); // contract, above 2^53 tinybar
  return { accounts, contracts: CONTRACTS };
}

describe("hedera adapter surface", () => {
  it("normalizes and validates addresses", () => {
    expect(hederaAdapter.vm).toBe("hedera");
    expect(hederaAdapter.normalizeAddress(chain, "0.0.123-vfmkw")).toBe("0.0.123");
    expect(hederaAdapter.normalizeAddress(chain, "0x000000000000000000000000000000000000007b")).toBe("0.0.123");
    expect(hederaAdapter.normalizeAddress(chain, "nope")).toBeNull();
    expect(hederaAdapter.isAddress(chain, "0.0.5")).toBe(true);
    expect(hederaAdapter.isAddress(chain, "0.0.5-zzzzz")).toBe(false);
  });

  it("builds HashScan links keyed on 0.0.N", () => {
    expect(hederaAdapter.explorerUrl(chain, "address", "0.0.123-vfmkw")).toBe("https://hashscan.io/mainnet/account/0.0.123");
    expect(hederaAdapter.explorerUrl(chain, "tx", "0.0.5@1794165040.107980111")).toBe("https://hashscan.io/mainnet/transaction/0.0.5@1794165040.107980111");
  });

  it("health probes the mirror and returns its URL", async () => {
    const mock = createMockMirror();
    await expect(hederaAdapter.health(chain, opts(mock))).resolves.toEqual([BASE]);
    const down = createMockMirror({ fail: () => 500 });
    await expect(hederaAdapter.health(chain, opts(down, { maxAttempts: 2 }))).rejects.toThrow(/500/);
  });
});

describe("hedera supply", () => {
  it("reads supply as exact BigInt tinybars", async () => {
    const mock = createMockMirror({ totalSupply: "5000000000000000000", releasedSupply: "4432714701836802108" });
    const meta = await hederaAdapter.tokenMeta(chain, {}, opts(mock));
    expect(meta.decimals).toBe(8);
    expect(meta.supplyRaw).toBe(5_000_000_000_000_000_000n);
    expect(meta.releasedSupplyRaw).toBe(4_432_714_701_836_802_108n);
    expect(meta.supply).toBe(50_000_000_000);
    expect(meta.symbol).toBe("HBAR");
  });
});

describe("hedera clock", () => {
  const mock = createMockMirror({ blockCount: 1000, blockTime: (n) => 1_000_000 + n * 2 });
  const clock = () => hederaAdapter.clock(chain, opts(mock));

  it("maps block number to timestamp", async () => {
    const c = clock();
    expect((await c.latest()).number).toBe(999);
    expect(await c.timeOf(10)).toBe(1_000_020);
  });

  it("finds the first block at or after a timestamp by binary search", async () => {
    const c = clock();
    const before = mock.calls.length;
    expect(await c.firstAtOrAfter(1_000_020)).toBe(10);
    expect(await c.firstAtOrAfter(1_000_021)).toBe(11);
    expect(await c.firstAtOrAfter(0)).toBe(0);
    expect(await c.firstAtOrAfter(1_000_000 + 999 * 2)).toBe(999);
    expect(await c.firstAtOrAfter(1_000_000 + 999 * 2 + 1)).toBeNull();
    expect(mock.calls.length - before).toBeLessThan(5 * 16 + 5);
  });

  it("accepts the shared (target, getTime, lo, hi) signature", async () => {
    const c = clock();
    expect(await c.firstAtOrAfter(50, async (n) => n * 10, 0, 100)).toBe(5);
    expect(await c.firstAtOrAfter(5000, async (n) => n * 10, 0, 100)).toBeNull();
  });
});

describe("hedera scanChain", () => {
  it("returns holders >= 1 HBAR, no contracts, no HTS-only, with exact balances", async () => {
    const pop = population();
    const scan = await hederaAdapter.scanChain(chain, opts(createMockMirror(pop)));
    const b = scan.balances;
    expect(b.get("0.0.1")).toBe(6);
    expect(b.has("0.0.7")).toBe(false); // zero HBAR
    expect(b.has("0.0.451")).toBe(false); // 1 tinybar short of the floor
    expect(b.get("0.0.452")).toBe(1);
    expect(b.has("0.0.453")).toBe(false); // HTS only
    for (const id of CONTRACTS) expect(b.has(`0.0.${id}`)).toBe(false);
    const expected = pop.accounts.filter((a) => a.balance >= HBAR && !CONTRACTS.includes(a.num));
    expect(b.size).toBe(expected.length);
    expect(scan.tokenTotals.legacy).toBe(Number(pop.accounts.reduce((sum, a) => sum + a.balance, 0n) / HBAR));
    expect(scan.checkpointData).toMatchObject({ vm: "hedera", holders: b.size, floorTinybar: "100000000", snapshotTimestamp: TS });
    expect(scan.checkpointData.contractsExcluded).toBe(4); // 10, 11, 200 and 454 are contracts holding >= 1 HBAR; 460 is not in the snapshot
    expect(scan.tokenAccountOwners).toBeInstanceOf(Map);
    expect(scan.chainKey).toBe("hedera");
  });

  it("keeps a contract that has a configured role (WHBAR as dex) and reports the HBAR left out", async () => {
    const pop = population();
    const withRole = { ...chain, contracts: { whbar: { address: "0.0.200", role: "dex" } } };
    const scan = await hederaAdapter.scanChain(withRole, opts(createMockMirror(pop)));
    expect(scan.balances.get("0.0.200")).toBe(205);
    expect(scan.balances.has("0.0.10")).toBe(false);
    expect(scan.checkpointData).toMatchObject({ contractsExcluded: 3, roleContractsKept: 1 });
    const all = pop.accounts.reduce((s, a) => s + a.balance, 0n);
    expect(BigInt(scan.checkpointData.unlistedRawTotal) + BigInt(scan.checkpointData.heldRawTotal)).toBe(all);
  });

  it("keeps a balance above 2^53 exact in the raw total", async () => {
    const mock = createMockMirror({ accounts: [{ num: 5, balance: 320_000_000_000_000_001n }, acct(6, 2)], contracts: [] });
    const scan = await hederaAdapter.scanChain({ ...chain, rangeWidth: 1000 }, opts(mock));
    expect(scan.checkpointData.heldRawTotal).toBe((320_000_000_000_000_001n + 2n * HBAR).toString());
    expect(scan.balances.get("0.0.5")).toBeCloseTo(3_200_000_000.00000001, 6);
  });

  it("pages with limit=100, no server-side floor filter, ordered by account id", async () => {
    const mock = createMockMirror(population());
    await hederaAdapter.scanChain(chain, opts(mock));
    const calls = mock.balanceCalls().slice(2).filter((c) => c.params.get("limit") !== "1");
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.params.get("limit")).toBe("100");
      expect(c.params.get("order")).toBe("asc");
      expect(c.params.get("account.balance")).toBeNull(); // filtered server-side it can return a stale balance
    }
  });

  it("retains only rows at or above the floor, as [id, tinybar text], but totals every balance", async () => {
    const accounts = [acct(1, 0, [{ token_id: "0.0.9", balance: 5 }]), acct(2, 3, [{ token_id: "0.0.9", balance: 5 }]), { num: 3, balance: HBAR - 1n }, acct(4, 7)];
    const states = [];
    const scan = await hederaAdapter.scanChain(chain, opts(createMockMirror({ accounts, contracts: [] }), { onProgress: (s) => states.push(structuredClone(s)) }));
    expect(Object.values(states.at(-1).ranges).flat()).toEqual([[2, "300000000"], [4, "700000000"]]);
    expect(scan.checkpointData.snapshotRawTotal).toBe(String(10n * HBAR + HBAR - 1n));
    expect(scan.checkpointData.nonzeroAccounts).toBe(3);
  });

  it("rejects a snapshot whose balances do not add up to total supply", async () => {
    const mock = createMockMirror({ ...population(), totalSupply: "5000000000000000000" });
    await expect(hederaAdapter.scanChain(chain, opts(mock))).rejects.toThrow(/sum to .* total supply is 5000000000000000000/);
  });

  it("records released supply read at the held snapshot", async () => {
    const mock = createMockMirror(population());
    const scan = await hederaAdapter.scanChain(chain, opts(mock));
    const supplyCall = mock.calls.find((c) => c.path === "/network/supply" && c.params.get("timestamp"));
    expect(supplyCall.params.get("timestamp")).toBe(scan.checkpointData.snapshotTimestamp);
    expect(scan.checkpointData.releasedAtSnapshotRaw).toBe("4432714701836802108");
  });

  it("honours a configured floor", async () => {
    const mock = createMockMirror({ accounts: [acct(1, 1), acct(2, 10), acct(3, 100)], contracts: [] });
    const scan = await hederaAdapter.scanChain({ ...chain, holderFloorTinybar: "1000000000" }, opts(mock));
    expect([...scan.balances.keys()]).toEqual(["0.0.2", "0.0.3"]);
  });

  it("ends cleanly when the last full page is followed by an empty page", async () => {
    const accounts = Array.from({ length: 200 }, (_, i) => acct(i + 1, 3));
    const mock = createMockMirror({ accounts, contracts: [] });
    const scan = await hederaAdapter.scanChain({ ...chain, rangeWidth: 1000 }, opts(mock));
    expect(scan.balances.size).toBe(200);
  });

  it("holds one explicit timestamp across every page", async () => {
    const mock = createMockMirror(population());
    const scan = await hederaAdapter.scanChain(chain, opts(mock));
    const stamped = mock.balanceCalls().slice(3).map((c) => c.params.get("timestamp"));
    expect(new Set(stamped)).toEqual(new Set([TS]));
    expect(scan.checkpointData.snapshotTimestamp).toBe(TS);
  });

  it("throws when the snapshot moves between pages", async () => {
    const mock = createMockMirror({ ...population(), snapshotTimestamp: (i) => (i < 14 ? TS : "1794165941.000000001") });
    await expect(hederaAdapter.scanChain(chain, opts(mock))).rejects.toThrow(/snapshot/i);
  });

  it("retries a transient page failure and returns the identical result", async () => {
    const clean = await hederaAdapter.scanChain(chain, opts(createMockMirror(population())));
    let failed = 0;
    const flaky = createMockMirror({ ...population(), fail: (path, _q, i) => (path === "/balances" && i > 2 && failed++ < 3 ? 503 : null) });
    const scan = await hederaAdapter.scanChain(chain, opts(flaky));
    expect(failed).toBeGreaterThanOrEqual(3);
    expect([...scan.balances]).toEqual([...clean.balances]);
  });

  it("a page that keeps failing rejects the scan: no partial result", async () => {
    let n = 0;
    const mock = createMockMirror({ ...population(), fail: (path) => (path === "/balances" && ++n > 3 ? 500 : null) });
    await expect(hederaAdapter.scanChain(chain, opts(mock, { maxAttempts: 3 }))).rejects.toThrow(/500/);
  });

  it("a failing contract list rejects the scan too", async () => {
    const mock = createMockMirror({ ...population(), fail: (path) => (path === "/contracts" ? 500 : null) });
    await expect(hederaAdapter.scanChain(chain, opts(mock, { maxAttempts: 2 }))).rejects.toThrow(/500/);
  });

  it("resumes a range from the last full page after a later page fails", async () => {
    const wide = { ...chain, rangeWidth: 1000 };
    const failAt200 = (path, query) => (path === "/balances" && /(?:gt:|gt%3A)0\.0\.200/.test(query) ? 500 : null);
    const states = [];
    const first = createMockMirror({ ...population(), fail: failAt200 });
    await expect(hederaAdapter.scanChain(wide, opts(first, { maxAttempts: 2, onProgress: (s) => states.push(structuredClone(s)) }))).rejects.toThrow(/500/);
    const saved = states.at(-1);
    expect(saved.open[0].previous).toBe(200);
    expect(saved.ranges).toEqual({});
    const before = JSON.parse(JSON.stringify(saved));
    const full = await hederaAdapter.scanChain(wide, opts(createMockMirror(population())));
    const second = createMockMirror(population());
    const resumed = await hederaAdapter.scanChain(wide, opts(second, { resume: saved }));
    expect([...resumed.balances]).toEqual([...full.balances]);
    expect(saved).toEqual(before);
    const cursors = second
      .balanceCalls()
      .map((c) => c.params.getAll("account.id").find((v) => v.startsWith("gt:") || v.startsWith("gte:")))
      .filter(Boolean);
    expect(cursors.some((v) => v === "gte:0.0.0" || v === "gt:0.0.100")).toBe(false);
    expect(cursors[0]).toBe("gt:0.0.200");
  });

  it("drops rows pushed after the last saved page when the end-of-range probe fails", async () => {
    const wide = { ...chain, rangeWidth: 1000 };
    const failProbe = (path, query) => (path === "/balances" && query.includes("limit=1&") && /gt(?::|%3A)0\.0\.454/.test(query) ? 500 : null);
    let live = null;
    const first = createMockMirror({ ...population(), fail: failProbe });
    await expect(hederaAdapter.scanChain(wide, opts(first, { maxAttempts: 2, onProgress: (s) => (live = s) }))).rejects.toThrow(/500/);
    expect(live.open[0].rows.length).toBeGreaterThan(live.open[0].count);
    const saved = JSON.parse(JSON.stringify(live));
    const full = await hederaAdapter.scanChain(wide, opts(createMockMirror(population())));
    const resumed = await hederaAdapter.scanChain(wide, opts(createMockMirror(population()), { resume: saved }));
    expect([...resumed.balances]).toEqual([...full.balances]);
    expect(resumed.checkpointData.snapshotRawTotal).toBe(full.checkpointData.snapshotRawTotal);
    expect(resumed.checkpointData.nonzeroAccounts).toBe(full.checkpointData.nonzeroAccounts);
  });

  it("resumes from a checkpoint without refetching finished ranges", async () => {
    const full = await hederaAdapter.scanChain(chain, opts(createMockMirror(population())));
    const states = [];
    const first = createMockMirror(population());
    await hederaAdapter.scanChain(chain, opts(first, { onProgress: (s) => states.push(structuredClone(s)) }));
    const source = states.find((s) => Object.keys(s.ranges).length > 0);
    const partial = JSON.parse(JSON.stringify(source));
    expect(Object.keys(partial.ranges).length).toBeGreaterThan(0);
    const second = createMockMirror(population());
    const resumed = await hederaAdapter.scanChain(chain, opts(second, { resume: partial }));
    expect([...resumed.balances]).toEqual([...full.balances]);
    expect(partial).toEqual(JSON.parse(JSON.stringify(source))); // the caller's checkpoint is not mutated
    expect(second.balanceCalls().length).toBeLessThan(first.balanceCalls().length);
    expect(second.balanceCalls().every((c) => !c.params.get("timestamp") || c.params.get("timestamp") === partial.timestamp)).toBe(true);
  });

  it("rejects a checkpoint made with a different floor or range width", async () => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    const run = (c, resume) => hederaAdapter.scanChain(c, opts(createMockMirror(population()), { resume }));
    const saved = states.find((s) => Object.keys(s.ranges).length > 0);
    await expect(run({ ...chain, holderFloorTinybar: "200000000" }, saved)).rejects.toThrow(/floor/);
    await expect(run({ ...chain, rangeWidth: 50 }, saved)).rejects.toThrow(/range width/);
  });

  it("resumes a pinned snapshot days later, because the stamp is one moment", async () => {
    const states = [];
    const full = await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    const saved = states.find((s) => Object.keys(s.ranges).length > 0);
    const snapMs = Number(TS) * 1000;
    const later = opts(createMockMirror(population()), { resume: saved, nowMs: () => snapMs + 48 * 3_600_000 });
    const resumed = await hederaAdapter.scanChain(chain, later);
    expect(resumed.checkpointData.snapshotTimestamp).toBe(saved.timestamp);
    expect([...resumed.balances]).toEqual([...full.balances]);
  });

  it("rejects a malformed, wrongly-versioned or non-numeric-age checkpoint", async () => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    const good = states.find((s) => Object.keys(s.ranges).length > 0);
    const run = (resume) => hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { resume }));
    const cursor = { op: "gt", from: 50, previous: 50, count: 0, rows: [], allRaw: "0", nonzero: 0 };
    await expect(run({ ...good, version: 1 })).rejects.toThrow(/version/);
    await expect(run({ ...good, ranges: undefined })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, totals: {} })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, maxId: 1.5 })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, timestamp: 12 })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, timestamp: "soon" })).rejects.toThrow(/not a number/);
    await expect(run({ ...good, open: [] })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, open: { 0: { ...cursor, op: "lt" } } })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, open: { 0: { ...cursor, count: 1 } } })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, open: { 0: { ...cursor, allRaw: "-1" } } })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, open: { 0: cursor }, ranges: { ...good.ranges, 0: [] }, totals: { ...good.totals, 0: { allRaw: "0", nonzero: 0 } } })).rejects.toThrow(/malformed/);
  });

  it("reports a finished range to onProgress only after storing it", async () => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    const done = states.find((s) => Object.keys(s.ranges).length > 0);
    expect(Object.keys(done.ranges)).toHaveLength(1);
    expect(done.open[Object.keys(done.ranges)[0]]).toBeUndefined();
    const [rows] = Object.values(done.ranges);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("returns balances above 2^53 tinybar as the exact nearest HBAR number", async () => {
    const mock = createMockMirror({ accounts: [{ num: 5, balance: 12_345_678_901_234_567n }, { num: 6, balance: 10_000_000_000_000_001n }], contracts: [] });
    const scan = await hederaAdapter.scanChain({ ...chain, rangeWidth: 1000 }, opts(mock));
    expect(scan.balances.get("0.0.5")).toBe(123456789.01234567);
    expect(scan.balances.get("0.0.6")).toBe(100000000.00000001);
  });

  it("lists more than one page of contracts", async () => {
    const accounts = Array.from({ length: 300 }, (_, i) => acct(i + 1, 5));
    const contracts = Array.from({ length: 250 }, (_, i) => i + 1);
    const scan = await hederaAdapter.scanChain({ ...chain, rangeWidth: 1000 }, opts(createMockMirror({ accounts, contracts })));
    expect(scan.balances.size).toBe(50);
    expect(scan.checkpointData.contractsExcluded).toBe(250);
  });
});

describe("hedera resumeProblem", () => {
  const saved = (extra = {}) => ({ version: 2, timestamp: "1794165040.107980111", maxId: 10, floor: "100000000", width: 100, ranges: {}, totals: {}, open: {}, ...extra });
  const at = (s) => ({ nowMs: () => Number(s) * 1000 });
  it("is null for a fitting, fresh checkpoint and names the problem otherwise", () => {
    expect(hederaAdapter.resumeProblem(chain, saved(), at(1794165040 + 3600))).toBeNull();
    expect(hederaAdapter.resumeProblem(chain, saved({ floor: "5" }), at(1794165040))).toMatch(/floor/);
    expect(hederaAdapter.resumeProblem(chain, saved(), at(1794165040 + 48 * 3600))).toBeNull();
  });
});

describe("hedera clusters: one held snapshot and the cluster that answered it", () => {
  const HEAD = "1794165294.000000001";
  // Two independent clusters write snapshots on their own 15-minute grids; the stamp only exists on one.
  const gridA = Array.from({ length: 6 }, (_, i) => `${1794165040 - (5 - i) * 900}.107980111`);
  const gridB = Array.from({ length: 6 }, (_, i) => `${1794164950 - (5 - i) * 900}.500000001`);
  const twoClusters = (extra = {}) => createMockMirror({ ...population(), clusters: { a: gridA, b: gridB }, headTimestamp: HEAD, ...extra });
  const baseline = async () => (await hederaAdapter.scanChain(chain, opts(twoClusters()))).balances;

  it("asks for the head once and holds the stamp and cluster that answered", async () => {
    const mock = twoClusters();
    const scan = await hederaAdapter.scanChain(chain, opts(mock));
    expect(scan.checkpointData.snapshotTimestamp).toBe(gridA.at(-1));
    expect(scan.checkpointData.snapshotClusterId).toBe("a");
    const pinned = mock.balanceCalls().filter((c) => c.params.get("timestamp"));
    expect(pinned.length).toBeGreaterThan(5);
    expect(new Set(pinned.map((c) => c.params.get("timestamp")).slice(1))).toEqual(new Set([gridA.at(-1)]));
    expect(mock.balanceCalls().some((c) => c.params.get("account.balance"))).toBe(false); // the floor is applied here, not by the server
  });

  it("completes with one snapshot when routing flips to the other cluster mid-range", async () => {
    const want = await baseline();
    const mock = twoClusters({ route: (i) => (i >= 12 && i % 3 === 0 ? "b" : "a") });
    const scan = await hederaAdapter.scanChain(chain, opts(mock));
    expect(scan.checkpointData.snapshotTimestamp).toBe(gridA.at(-1));
    expect(scan.checkpointData.snapshotMismatchRetries).toBeGreaterThan(0);
    expect([...scan.balances]).toEqual([...want]);
  });

  it("rejects when the other cluster keeps answering past the wait budget, and never accepts its pages", async () => {
    const sleeps = [];
    const mock = twoClusters({ route: (i) => (i >= 12 ? "b" : "a") });
    await expect(hederaAdapter.scanChain(chain, opts(mock, { snapshotWaitMs: 60_000, sleep: async (ms) => void sleeps.push(ms) }))).rejects.toThrow(/snapshot moved|cluster/);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
  });

  it("retries an empty page from the wrong cluster instead of taking it as the end of a range", async () => {
    const want = await baseline();
    // cluster c holds no snapshot at or before the stamp, so everything it answers is an empty page with timestamp null
    const mock = createMockMirror({ ...population(), clusters: { a: gridA, c: [] }, headTimestamp: HEAD, route: (i) => (i >= 8 && i % 4 === 1 ? "c" : "a") });
    const scan = await hederaAdapter.scanChain(chain, opts(mock));
    expect(scan.checkpointData.snapshotMismatchRetries).toBeGreaterThan(0);
    expect([...scan.balances]).toEqual([...want]);
  });

  it("retries a 404 on a pinned request, logs the cluster that sent it, and still completes", async () => {
    const want = await baseline();
    const mock = twoClusters({ route: (i) => (i >= 10 && i % 5 === 0 ? "b" : "a"), notFound: (p, q, i, cluster) => cluster === "b" && p === "/balances" });
    const scan = await hederaAdapter.scanChain(chain, opts(mock));
    expect(scan.checkpointData.snapshotWaitByCluster.b.retries).toBeGreaterThan(0);
    expect(scan.checkpointData.snapshotWaitByCluster.b.waitedMs).toBeGreaterThan(0);
    expect([...scan.balances]).toEqual([...want]);
  });

  it("a 404 that outlasts the wait budget rejects", async () => {
    const mock = twoClusters({ route: (i) => (i >= 10 ? "b" : "a"), notFound: (p, q, i, cluster) => cluster === "b" && p === "/balances" });
    await expect(hederaAdapter.scanChain(chain, opts(mock, { snapshotWaitMs: 60_000, sleep: async () => {} }))).rejects.toThrow(/404 from cluster b/);
  });

  it("any other 4xx stays fatal", async () => {
    const mock = twoClusters({ fail: (p, q, i) => (i === 12 ? 403 : null) });
    await expect(hederaAdapter.scanChain(chain, opts(mock))).rejects.toThrow(/403/);
  });

  it("never takes an empty page from a response with no cluster id as a range end", async () => {
    const want = await baseline();
    const mock = createMockMirror({ ...population(), clusters: { a: gridA, unknown: gridA }, headTimestamp: HEAD, route: (i) => (i >= 8 && i % 4 === 1 ? "unknown" : "a") });
    const scan = await hederaAdapter.scanChain(chain, opts(mock));
    expect(scan.checkpointData.snapshotWaitByCluster.unknown.retries).toBeGreaterThan(0);
    expect([...scan.balances]).toEqual([...want]);
  });

  it("an empty page from the held cluster is still a real empty range", async () => {
    const accounts = [acct(1, 3), acct(2, 3), acct(950, 3)];
    const scan = await hederaAdapter.scanChain(chain, opts(createMockMirror({ accounts, contracts: [], clusters: { a: gridA }, headTimestamp: HEAD })));
    expect(scan.balances.size).toBe(3);
  });

  it("learns the cluster of a resumed scan from the first response answering its stamp", async () => {
    const mock = twoClusters({ route: (i) => (i < 2 ? "b" : "a") });
    const first = await hederaAdapter.scanChain(chain, opts(twoClusters(), { onProgress: () => {} }));
    let state = null;
    await hederaAdapter.scanChain(chain, opts(twoClusters(), { onProgress: (s) => (state ??= s) }));
    const resumed = await hederaAdapter.scanChain(chain, opts(mock, { resume: state, nowMs: () => Number(state.timestamp.split(".")[0]) * 1000 + 1000 }));
    expect(resumed.checkpointData.snapshotClusterId).toBe("a");
    expect([...resumed.balances]).toEqual([...first.balances]);
  });
});

describe("hedera range completeness", () => {
  const w = { ...chain, rangeWidth: 100 };
  const base = () => {
    // range [100,200) holds exactly 100 qualifying rows; the last range [300,351) holds none
    const accounts = [...Array.from({ length: 100 }, (_, i) => acct(100 + i, 3)), acct(10, 3), acct(350, 0)];
    return { accounts, contracts: [] };
  };
  const firstPage = (params, lo) => params.get("limit") === "100" && params.getAll("account.id")[0] === `gte:0.0.${lo}`;

  it("completes on an exact multiple of 100 rows and on a range with no holder (empty page, null timestamp)", async () => {
    const mock = createMockMirror(base());
    const scan = await hederaAdapter.scanChain(w, opts(mock));
    expect(scan.balances.size).toBe(101);
    const probes = mock.balanceCalls().filter((c) => c.params.get("limit") === "1" && c.params.get("timestamp") === TS && c.params.getAll("account.id").length === 2);
    expect(probes.length).toBe(4); // one confirming probe per range
    expect(probes.every((c) => c.params.get("account.id") !== null)).toBe(true);
  });

  const rejects = async (tamper, pattern) => {
    const mock = createMockMirror({ ...base(), tamper });
    await expect(hederaAdapter.scanChain(w, opts(mock))).rejects.toThrow(pattern);
  };

  it("rejects a full page with no links object", () =>
    rejects((p, q, body) => (p === "/balances" && firstPage(q, 100) ? { timestamp: body.timestamp, balances: body.balances } : undefined), /links/));
  it("rejects a full page whose next is null while rows remain, accepts it when nothing follows (live behaviour)", async () => {
    const accounts = Array.from({ length: 150 }, (_, i) => acct(i + 1, 3));
    const nullNext = (p, q, body) => (p === "/balances" && q.get("limit") === "100" && q.getAll("account.id")[0] === "gte:0.0.0" ? { ...body, links: { next: null } } : undefined);
    const wide = { ...chain, rangeWidth: 1000 };
    await expect(hederaAdapter.scanChain(wide, opts(createMockMirror({ accounts, contracts: [], tamper: nullNext })))).rejects.toThrow(/ended early/);
    const exact = Array.from({ length: 100 }, (_, i) => acct(i + 1, 3));
    const ok = await hederaAdapter.scanChain(wide, opts(createMockMirror({ accounts: exact, contracts: [], tamper: nullNext })));
    expect(ok.balances.size).toBe(100);
  });
  it("rejects a short page with next null while rows remain", () =>
    rejects((p, q, body) => (p === "/balances" && firstPage(q, 100) ? { ...body, balances: body.balances.slice(0, 50), links: { next: null } } : undefined), /ended early/));
  it("rejects an empty page with next null while rows remain", () =>
    rejects((p, q, body) => (p === "/balances" && firstPage(q, 100) ? { timestamp: null, balances: [], links: { next: null } } : undefined), /ended early/));
  it("rejects a short page that still has a next link", () =>
    rejects((p, q, body) => (p === "/balances" && firstPage(q, 100) ? { ...body, balances: body.balances.slice(0, 50), links: { next: "/x" } } : undefined), /short page/));
  it("rejects a body without a balances array", () =>
    rejects((p, q, body) => (p === "/balances" && firstPage(q, 100) ? { timestamp: body.timestamp, links: body.links } : undefined), /balances array/));
  it("rejects rows out of order or beyond the range", async () => {
    await rejects((p, q, body) => (p === "/balances" && firstPage(q, 100) ? { ...body, balances: [...body.balances].reverse() } : undefined), /out of order/);
    await rejects(
      (p, q, body) => (p === "/balances" && firstPage(q, 0) ? { ...body, balances: [...body.balances, { account: "0.0.150", balance: 300000000, tokens: [] }] } : undefined),
      /out of order|outside/,
    );
  });
  it("rejects a non-empty page from another snapshot but accepts an empty page with null timestamp", () =>
    rejects((p, q, body) => (p === "/balances" && firstPage(q, 100) ? { ...body, timestamp: "1794160000.000000001" } : undefined), /snapshot/));
  const lone = () => ({ accounts: [acct(1, 3), acct(2, 3), acct(350, 0)], contracts: [] });
  const emptyBody = { timestamp: null, balances: [], links: { next: null } };
  const rejectsLone = async (tamper, pattern, data = lone()) =>
    expect(hederaAdapter.scanChain(w, opts(createMockMirror({ ...data, tamper })))).rejects.toThrow(pattern);
  const isPage = (p, q, lo) => p === "/balances" && q.get("limit") === "100" && q.getAll("account.id")[0] === `gte:0.0.${lo}`;
  const isProbe = (p, q) => p === "/balances" && q.get("limit") === "1" && q.get("timestamp") && q.getAll("account.id").length === 2;

  it("a probe sees exactly one qualifying row right after a truncated page", () =>
    rejectsLone((p, q, body) => (isPage(p, q, 0) ? { ...body, balances: body.balances.slice(0, 1), links: { next: null } } : undefined), /ended early/));
  it("a probe sees a row at id hi-1", () =>
    rejectsLone((p, q) => (isPage(p, q, 0) ? emptyBody : undefined), /ended early/, { accounts: [acct(99, 3), acct(350, 0)], contracts: [] }));
  it("an empty page carrying a moved non-null timestamp rejects", () =>
    rejectsLone((p, q) => (isPage(p, q, 300) ? { ...emptyBody, timestamp: "1794160000.000000001" } : undefined), /snapshot moved/));
  it("an empty page with no timestamp key rejects", () =>
    rejectsLone((p, q) => (isPage(p, q, 300) ? { balances: [], links: { next: null } } : undefined), /snapshot moved/));
  it("a probe carrying a moved non-null timestamp rejects", () => {
    return rejectsLone((p, q) => (isProbe(p, q) ? { ...emptyBody, timestamp: "1794160000.000000001" } : undefined), /snapshot moved/);
  });
  it("rejects when the snapshot timestamp serves empty pages for a populated range (no snapshot behind it)", () =>
    rejectsLone((p, q) => (p === "/balances" && q.get("timestamp") && q.get("order") !== "desc" ? emptyBody : undefined), /lists no accounts/));
  it("checks the snapshot exists once per scan, with no id filter", async () => {
    const mock = createMockMirror(lone());
    await hederaAdapter.scanChain(w, opts(mock));
    const checks = mock.balanceCalls().filter((c) => c.params.get("limit") === "1" && c.params.get("timestamp") && c.params.getAll("account.id").length === 0 && c.params.get("order") !== "desc");
    expect(checks).toHaveLength(1);
  });

  it("rejects a /contracts page with no links", async () => {
    const mock = createMockMirror({ ...base(), contracts: [1, 2], tamper: (p, q, body) => (p === "/contracts" ? { contracts: body.contracts } : undefined) });
    await expect(hederaAdapter.scanChain(w, opts(mock))).rejects.toThrow(/links/);
  });
});
