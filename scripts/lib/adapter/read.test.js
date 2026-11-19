import { createHash } from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { AdapterReadError, readChanges, readFullList, readPositionChanges, readPositionsFull } from "./read.js";
import { createSyntheticAdapter } from "./synthetic.js";

const EPOCH_MS = Date.parse("2026-01-01T00:00:00Z");
const dayText = (d) => new Date(EPOCH_MS + d * 86_400_000).toISOString().slice(0, 10);
const DAYS = 5;
const SHAPE = { seed: 11, accounts: 2000, changesPerDay: 150, days: DAYS, stakeShare: 0.2, maxPageRows: 100 };
const FAULTS = { refuseEvery: 3, shortPageEvery: 4, repeatRowEvery: 5, shuffle: true, rejectResumeEvery: 23 };
const RETRIES = { maxRetries: 25 };

const hashRows = (rows) =>
  createHash("sha1")
    .update(rows.map((r) => `${r.account}:${r.balance}`).sort().join("\n"))
    .digest("hex");
const hashTransfers = (ts) =>
  createHash("sha1")
    .update(ts.map((t) => `${t.from}>${t.to}:${t.amount}@${t.height}`).sort().join("\n"))
    .digest("hex");
const cursor = (a, d) => a.settledEnd(null, dayText(d));

async function readEverything(adapter) {
  const out = { full: [], changes: [], transfers: [], stake: [], stakeChanges: [] };
  await readFullList(adapter, null, cursor(adapter, DAYS), { n: 10, ...RETRIES, onRows: (r) => out.full.push(...r) });
  await readChanges(adapter, null, cursor(adapter, 0), cursor(adapter, DAYS), { ...RETRIES, onRows: (r) => out.changes.push(...r), onTransfers: (t) => out.transfers.push(...t) });
  await readPositionsFull(adapter, null, "stake", { n: 10, ...RETRIES, onRows: (r) => out.stake.push(...r) });
  await readPositionChanges(adapter, null, "stake", cursor(adapter, 0), cursor(adapter, DAYS), { ...RETRIES, onRows: (r) => out.stakeChanges.push(...r) });
  return out;
}
const fingerprint = (out) => ({
  full: [out.full.length, hashRows(out.full)],
  changes: [out.changes.length, hashRows(out.changes)],
  transfers: [out.transfers.length, hashTransfers(out.transfers)],
  stake: [out.stake.length, hashRows(out.stake)],
  stakeChanges: [out.stakeChanges.length, hashRows(out.stakeChanges)],
});

describe("readers deliver the same rows with and without faults", () => {
  const clean = createSyntheticAdapter(SHAPE);
  const expected = readEverything(clean).then(fingerprint);

  it("delivers a full, non-empty read with no faults", async () => {
    const f = await expected;
    expect(f.full[0]).toBeGreaterThan(1000);
    expect(f.changes[0]).toBeGreaterThan(100);
    expect(f.transfers[0]).toBeGreaterThan(100);
    expect(f.stake[0]).toBeGreaterThan(100);
    expect(f.stakeChanges[0]).toBeGreaterThan(10);
  });

  for (const [name, faults] of Object.entries({
    refuse: { refuseEvery: 2 },
    "short pages": { shortPageEvery: 3 },
    "repeated rows": { repeatRowEvery: 2 },
    shuffle: { shuffle: true },
    "rejected tokens": { rejectResumeEvery: 9 },
    "all together": FAULTS,
  })) {
    it(`matches the clean read with ${name}`, async () => {
      const faulty = createSyntheticAdapter({ ...SHAPE, faults });
      expect(fingerprint(await readEverything(faulty))).toEqual(await expected);
    });
  }

  it("restarts a range on a rejected token without delivering a row twice, sorted or not", async () => {
    for (const shuffle of [false, true]) {
      const adapter = createSyntheticAdapter({ ...SHAPE, faults: { rejectResumeEvery: 7, shuffle } });
      const rows = [];
      const stats = await readFullList(adapter, null, cursor(adapter, DAYS), { n: 4, ...RETRIES, onRows: (r) => rows.push(...r) });
      expect(stats.restarts).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.account)).size).toBe(rows.length);
      expect(hashRows(rows)).toBe((await expected).full[1]);
    }
  });

  it("repeats and short pages are retried, and the retries show in the request count", async () => {
    const adapter = createSyntheticAdapter({ ...SHAPE, faults: { shortPageEvery: 2, repeatRowEvery: 3 } });
    const stats = await readFullList(adapter, null, cursor(adapter, DAYS), { n: 2, maxRetries: 25 });
    expect(stats.requests).toBeGreaterThan(stats.pages);
  });
});

describe("readers fail instead of returning a short or damaged read", () => {
  const readAll = (adapter, options = {}) => readFullList(adapter, null, cursor(adapter, DAYS), { n: 3, maxRetries: 4, ...options });

  it("throws when the ledger refuses every call", async () => {
    const adapter = createSyntheticAdapter({ ...SHAPE, faults: { refuseEvery: 1 } });
    await expect(readAll(adapter)).rejects.toThrow(/fullList range 0\/3, first page: gave up after 4 retries/);
  });

  it("throws on a ledger that always returns short pages, in every reader", async () => {
    const adapter = createSyntheticAdapter({ ...SHAPE, faults: { shortPageEvery: 1 } });
    await expect(readAll(adapter)).rejects.toThrow(/page holds \d+ rows, expected \d+/);
    await expect(readChanges(adapter, null, cursor(adapter, 0), cursor(adapter, DAYS), { maxRetries: 4 })).rejects.toThrow(/changes 0\.\.5, first page: gave up/);
    await expect(readPositionsFull(adapter, null, "stake", { n: 2, maxRetries: 4 })).rejects.toThrow(AdapterReadError);
  });

  it("throws on a ledger that always repeats a row", async () => {
    const adapter = createSyntheticAdapter({ ...SHAPE, faults: { repeatRowEvery: 1 } });
    await expect(readAll(adapter)).rejects.toThrow(/appears twice|not after/);
  });

  it("throws on a ledger that rejects every resume point, naming the range", async () => {
    const adapter = createSyntheticAdapter({ ...SHAPE, faults: { rejectResumeEvery: 1 } });
    await expect(readAll(adapter)).rejects.toThrow(/range 0\/3: gave up after 4 restarts/);
  });

  const lying = (patch) => {
    const base = createSyntheticAdapter(SHAPE);
    return { ...base, fullList: (a, at, range, page) => patch(base.fullList(a, at, range, page)), changes: (a, f, t, page) => patch(base.changes(a, f, t, page)) };
  };

  it("throws when the last page states the wrong total or the wrong sum", async () => {
    const total = lying((p) => (p.next === null ? { ...p, total: p.total + 1 } : p));
    await expect(readAll(total)).rejects.toThrow(/sequence holds \d+ rows, the last page says \d+/);
    await expect(readChanges(total, null, cursor(total, 0), cursor(total, DAYS), { maxRetries: 2 })).rejects.toThrow(/changes 0\.\.5.*gave up after 2 restarts/);
    const sum = lying((p) => (p.next === null && p.sum !== undefined ? { ...p, sum: p.sum + 1n } : p));
    await expect(readAll(sum)).rejects.toThrow(/sums to \d+, the last page says \d+/);
  });

  it("throws on a page without a count, a total, a bigint balance or the cursor asked for", async () => {
    await expect(readAll(lying((p) => ({ ...p, count: undefined })))).rejects.toThrow(/no integer count/);
    await expect(readAll(lying((p) => (p.next === null ? { ...p, total: undefined } : p)))).rejects.toThrow(/no integer total/);
    await expect(readAll(lying((p) => ({ ...p, rows: p.rows.map((r) => ({ ...r, balance: Number(r.balance) })) })))).rejects.toThrow(/malformed row/);
    await expect(readAll(lying((p) => ({ ...p, at: { height: 0, id: "elsewhere" } })))).rejects.toThrow(/not the requested cursor/);
  });

  it("does not retry an error that is not marked retryable, and keeps it as the cause", async () => {
    const boom = new Error("disk on fire");
    let calls = 0;
    const adapter = { ...createSyntheticAdapter(SHAPE), fullList: () => { calls += 1; throw boom; } };
    await expect(readAll(adapter)).rejects.toMatchObject({ cause: boom, message: expect.stringContaining("disk on fire") });
    expect(calls).toBe(1);
  });

  it("refuses a past cursor on a ledger that cannot be read in the past", async () => {
    const adapter = createSyntheticAdapter({ ...SHAPE, pastReadable: false });
    await expect(readAll(adapter)).rejects.toThrow(/cannot be read at a past cursor/);
    await expect(readFullList(adapter, null, "live", { n: 2 })).resolves.toMatchObject({ ranges: 2 });
  });
});

describe("readers stream", () => {
  it("hands rows over page by page and returns counts, not rows", async () => {
    const adapter = createSyntheticAdapter(SHAPE);
    const sizes = [];
    const stats = await readFullList(adapter, null, cursor(adapter, DAYS), { n: 4, onRows: (rows) => sizes.push(rows.length) });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(sizes.length).toBe(stats.pages);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(stats.rows);
    expect(stats.sum).toBe(adapter.discover(null).supply);
    expect(stats).not.toHaveProperty("rowList");
  });
});

describe("memory", () => {
  // A million accounts, rows discarded in the callback. Live heap is measured after a forced collection every
  // 100 pages: what the reader and the adapter hold, not garbage waiting for a sweep. Holding the million rows
  // would take over 150 MB, so the bound below is generous for the buffers and still proves nothing accumulates.
  const HEAP_GROWTH_BOUND_BYTES = 48 * 1024 * 1024;
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");

  it("reads a full list of 1,000,000 accounts with bounded heap growth", async () => {
    const adapter = createSyntheticAdapter({ seed: 3, accounts: 1_000_000, changesPerDay: 10_000, days: 3, maxPageRows: 1000, stakeShare: 0 });
    gc();
    const before = process.memoryUsage().heapUsed;
    let peak = 0;
    let pages = 0;
    const stats = await readFullList(adapter, null, "live", {
      n: 100,
      onRows: () => {
        if (++pages % 100 === 0) {
          gc();
          peak = Math.max(peak, process.memoryUsage().heapUsed - before);
        }
      },
    });
    expect(stats.rows).toBeGreaterThan(800_000);
    expect(stats.sum).toBe(adapter.discover(null).supply);
    expect(pages).toBeGreaterThan(900);
    expect(peak).toBeLessThan(HEAP_GROWTH_BOUND_BYTES);
  }, 60_000);
});

// Adapters written by hand to misbehave in ways the generated ledger does not: every reader must stop with a
// named error, quickly, whatever the ledger does.
describe("readers always stop", () => {
  const capabilities = { pastReadable: true, changeSource: "asset-records", listsTransfers: false, balanceMovesWithoutRecord: false, maxPageRows: 10 };
  // `serve(token, call)` answers every page call of both readers; fullList replies also carry `at`.
  const handmade = (serve, extra = {}) => ({
    family: "handmade",
    capabilities: { ...capabilities, ...extra },
    positionKinds: [],
    ranges: () => [{ from: 0, to: 1 }],
    fullList: (_asset, _at, _range, token = null) => ({ at: { height: 1, id: "x" }, ...serve(token) }),
    changes: (_asset, _from, _to, token = null) => serve(token),
  });
  const from = { height: 0, id: "a" };
  const to = { height: 1, id: "b" };
  const readers = {
    fullList: (adapter, options) => readFullList(adapter, null, "live", options),
    changes: (adapter, options) => readChanges(adapter, null, from, to, options),
  };
  const accountAt = (n) => `acct-${n.toString(16).padStart(12, "0")}`;
  const freshPage = (n, next) => ({ rows: [{ account: accountAt(n), balance: 1n }], count: 1, next });

  for (const [name, read] of Object.entries(readers)) {
    describe(name, () => {
      it("throws on endless empty pages that each carry a fresh token", async () => {
        let calls = 0;
        const adapter = handmade(() => ({ rows: [], count: 0, next: `n${(calls += 1)}` }));
        const started = Date.now();
        await expect(read(adapter, {})).rejects.toThrow(/more than 100 empty pages in a row.*maxEmptyPages/);
        expect(Date.now() - started).toBeLessThan(1000);
        await expect(read(adapter, { maxEmptyPages: 3 })).rejects.toThrow(/more than 3 empty pages in a row/);
      });

      it("accepts a few empty pages that carry a token, then rows", async () => {
        let call = 0;
        const adapter = handmade(() => {
          call += 1;
          if (call <= 3) return { rows: [], count: 0, next: `n${call}` };
          return { rows: [], count: 0, next: null, total: 0, sum: 0n };
        });
        await expect(read(adapter, { maxEmptyPages: 3 })).resolves.toMatchObject({ rows: 0 });
      });

      it("throws on endless pages of new accounts, naming the page bound", async () => {
        let calls = 0;
        const adapter = handmade(() => freshPage((calls += 1), `n${calls}`), { sortedPages: true, sortedChanges: true });
        const started = Date.now();
        await expect(read(adapter, { maxPages: 200 })).rejects.toThrow(/more than 200 pages.*maxPages/);
        expect(Date.now() - started).toBeLessThan(1000);
      });

      it("throws with a named error when an unsorted sequence would track too many accounts", async () => {
        let calls = 0;
        const adapter = handmade(() => freshPage((calls += 1), `n${calls}`));
        const started = Date.now();
        const remedies = name === "changes" ? /two halves.*sorted changes/ : /more ranges.*sorted pages/;
        await expect(read(adapter, { maxTrackedAccounts: 50 })).rejects.toThrow(new RegExp(`more than 50 accounts.*too large for an unsorted sequence.*${remedies.source}`));
        const error = await read(adapter, { maxTrackedAccounts: 50 }).catch((e) => e);
        expect(error).toBeInstanceOf(AdapterReadError);
        expect(error).toMatchObject({ code: "TOO_MANY_UNSORTED", bound: 50 });
        expect(error.tracked).toBeGreaterThan(50);
        expect(Date.now() - started).toBeLessThan(1000);
      });

      it("throws on a token cycle of length 2, and on a token that points at itself", async () => {
        let calls = 0;
        const cycle = handmade((token) => freshPage((calls += 1), token === "a" ? "b" : "a"), { sortedPages: true, sortedChanges: true });
        const started = Date.now();
        await expect(read(cycle, {})).rejects.toThrow(/page token (a|b) repeats a recent page token/);
        const self = handmade((token) => freshPage((calls += 1), token ?? "s"), { sortedPages: true, sortedChanges: true });
        await expect(read(self, {})).rejects.toThrow(/repeats a recent page token/);
        expect(Date.now() - started).toBeLessThan(1000);
      });

      it("turns a thrown null or string into a named error, not a TypeError", async () => {
        for (const thrown of [null, "plain string", undefined]) {
          const adapter = handmade(() => {
            throw thrown;
          });
          await expect(read(adapter, {})).rejects.toBeInstanceOf(AdapterReadError);
          await expect(read(adapter, {})).rejects.toThrow(name === "changes" ? /changes 0\.\.1, first page/ : /fullList range 0\/1, first page/);
        }
      });
    });
  }

  it("rejects n that is not an integer of at least 1, in both full readers", async () => {
    const adapter = handmade(() => ({ rows: [], count: 0, next: null, total: 0, sum: 0n }));
    for (const n of [2.5, 0, -1, Number.NaN]) {
      await expect(readFullList(adapter, null, "live", { n })).rejects.toThrow(/n must be an integer of at least 1/);
    }
    await expect(readFullList(adapter, null, "live", { n: 2 })).resolves.toMatchObject({ rows: 0 });
  });
});

describe("sorted changes", () => {
  const capabilities = { pastReadable: true, changeSource: "asset-records", listsTransfers: false, balanceMovesWithoutRecord: false, maxPageRows: 2 };
  const names = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const pageOf = (list, size) => (token = null) => {
    const start = token === null ? 0 : Number(token);
    const rows = list.slice(start, start + size).map((account) => ({ account, balance: 1n }));
    const end = start + size;
    return { rows, count: rows.length, next: end >= list.length ? null : String(end), ...(end >= list.length ? { total: list.length } : {}) };
  };
  const adapterOf = (list, sortedChanges) => ({ family: "h", capabilities: { ...capabilities, sortedChanges }, positionKinds: [], changes: (_a, _f, _t, token) => pageOf(list, 2)(token) });
  const range = [{ height: 0, id: "a" }, { height: 1, id: "b" }];

  it("reads sorted changes with no account tracked, where the unsorted check would refuse", async () => {
    const rows = [];
    await readChanges(adapterOf(names, true), null, ...range, { maxTrackedAccounts: 1, onRows: (r) => rows.push(...r) });
    expect(rows.map((r) => r.account)).toEqual(names);
    await expect(readChanges(adapterOf(names, false), null, ...range, { maxTrackedAccounts: 1 })).rejects.toThrow(/too large for an unsorted sequence/);
  });

  it("throws on a repeat or an out-of-order account across pages of sorted changes", async () => {
    await expect(readChanges(adapterOf(["a1", "a2", "a2", "a3"], true), null, ...range, { maxRetries: 2 })).rejects.toThrow(/not after/);
    await expect(readChanges(adapterOf(["a1", "a3", "a2", "a4"], true), null, ...range, { maxRetries: 2 })).rejects.toThrow(/not after/);
  });
});
