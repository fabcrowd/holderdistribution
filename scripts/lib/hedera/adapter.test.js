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
    expect(scan.tokenTotals.legacy).toBe(50_000_000_000);
    expect(scan.checkpointData).toMatchObject({ vm: "hedera", holders: b.size, floorTinybar: "100000000", snapshotTimestamp: TS });
    expect(scan.checkpointData.contractsExcluded).toBe(4); // 10, 11, 200 and 454 are contracts holding >= 1 HBAR; 460 is not in the snapshot
    expect(scan.tokenAccountOwners).toBeInstanceOf(Map);
    expect(scan.chainKey).toBe("hedera");
  });

  it("keeps a balance above 2^53 exact in the raw total", async () => {
    const mock = createMockMirror({ accounts: [{ num: 5, balance: 320_000_000_000_000_001n }, acct(6, 2)], contracts: [] });
    const scan = await hederaAdapter.scanChain({ ...chain, rangeWidth: 1000 }, opts(mock));
    expect(scan.checkpointData.heldRawTotal).toBe((320_000_000_000_000_001n + 2n * HBAR).toString());
    expect(scan.balances.get("0.0.5")).toBeCloseTo(3_200_000_000.00000001, 6);
  });

  it("pages with limit=100, the floor filter, ordered by account id", async () => {
    const mock = createMockMirror(population());
    await hederaAdapter.scanChain(chain, opts(mock));
    const calls = mock.balanceCalls().slice(2).filter((c) => c.params.get("limit") !== "1");
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.params.get("limit")).toBe("100");
      expect(c.params.get("order")).toBe("asc");
      expect(c.params.get("account.balance")).toBe(`gte:${HEDERA_HOLDER_FLOOR_TINYBAR}`);
    }
  });

  it("honours a configured floor", async () => {
    const mock = createMockMirror({ accounts: [acct(1, 1), acct(2, 10), acct(3, 100)], contracts: [] });
    const scan = await hederaAdapter.scanChain({ ...chain, holderFloorTinybar: "1000000000" }, opts(mock));
    expect([...scan.balances.keys()]).toEqual(["0.0.2", "0.0.3"]);
    expect(mock.balanceCalls().filter((c) => c.params.get("account.balance")).at(-1).params.get("account.balance")).toBe("gte:1000000000");
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
    const stamped = mock.balanceCalls().slice(2).map((c) => c.params.get("timestamp"));
    expect(new Set(stamped)).toEqual(new Set([TS]));
    expect(scan.checkpointData.snapshotTimestamp).toBe(TS);
  });

  it("throws when the snapshot moves between pages", async () => {
    const mock = createMockMirror({ ...population(), snapshotTimestamp: (i) => (i < 4 ? TS : "1794165941.000000001") });
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

  it("resumes from a checkpoint without refetching finished ranges", async () => {
    const full = await hederaAdapter.scanChain(chain, opts(createMockMirror(population())));
    const states = [];
    const first = createMockMirror(population());
    await hederaAdapter.scanChain(chain, opts(first, { onProgress: (s) => states.push(structuredClone(s)) }));
    const partial = JSON.parse(JSON.stringify(states[1]));
    expect(Object.keys(partial.ranges).length).toBeGreaterThan(0);
    const second = createMockMirror(population());
    const resumed = await hederaAdapter.scanChain(chain, opts(second, { resume: partial }));
    expect([...resumed.balances]).toEqual([...full.balances]);
    expect(partial).toEqual(JSON.parse(JSON.stringify(states[1]))); // the caller's checkpoint is not mutated
    expect(second.balanceCalls().length).toBeLessThan(first.balanceCalls().length);
    expect(second.balanceCalls().every((c) => !c.params.get("timestamp") || c.params.get("timestamp") === partial.timestamp)).toBe(true);
  });

  it("rejects a checkpoint made with a different floor or range width", async () => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    const run = (c, resume) => hederaAdapter.scanChain(c, opts(createMockMirror(population()), { resume }));
    await expect(run({ ...chain, holderFloorTinybar: "200000000" }, states[1])).rejects.toThrow(/floor/);
    await expect(run({ ...chain, rangeWidth: 50 }, states[1])).rejects.toThrow(/range width/);
  });

  it("rejects a checkpoint whose snapshot is older than the age limit", async () => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    const snapMs = Number(TS) * 1000;
    const fresh = opts(createMockMirror(population()), { resume: states[1], nowMs: () => snapMs + 5 * 3_600_000 });
    await expect(hederaAdapter.scanChain(chain, fresh)).resolves.toBeDefined();
    const stale = opts(createMockMirror(population()), { resume: states[1], nowMs: () => snapMs + 7 * 3_600_000 });
    await expect(hederaAdapter.scanChain(chain, stale)).rejects.toThrow(/old/);
  });

  it("rejects a malformed, wrongly-versioned or non-numeric-age checkpoint", async () => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    const good = states[1];
    const run = (resume) => hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { resume }));
    await expect(run({ ...good, version: 2 })).rejects.toThrow(/version/);
    await expect(run({ ...good, ranges: undefined })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, maxId: 1.5 })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, timestamp: 12 })).rejects.toThrow(/malformed/);
    await expect(run({ ...good, timestamp: "soon" })).rejects.toThrow(/not a number/);
  });

  it("reports a finished range to onProgress only after storing it", async () => {
    const states = [];
    await hederaAdapter.scanChain(chain, opts(createMockMirror(population()), { onProgress: (s) => states.push(structuredClone(s)) }));
    expect(Object.keys(states[0].ranges)).toHaveLength(1);
    const [rows] = Object.values(states[0].ranges);
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
    const probes = mock.balanceCalls().filter((c) => c.params.get("limit") === "1" && c.params.get("timestamp") === TS && c.params.get("account.balance"));
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
  it("a probe carrying a moved non-null timestamp rejects", () =>
    rejectsLone((p, q) => (isProbe(p, q) ? { ...emptyBody, timestamp: "1794160000.000000001" } : undefined), /snapshot moved/));
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
