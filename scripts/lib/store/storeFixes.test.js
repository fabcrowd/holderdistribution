// Fixes after the A1 review: the copy reset on a second part of the copy day, reads
// before what the index can rebuild, the cost of a past-day write, several splits in
// one publish, and keys that are not well-formed Unicode.
import { describe, it, expect } from "vitest";
import { Harness, readState, keysIn, fmt } from "./storeTestKit.js";
import { startYearlyCopy, runYearlyCopyNight, readCopySlice, copyStatus } from "./yearlyCopy.js";
import { rowsAt, readCurrentBucket, createReader, walkPosition, changesOn } from "./tableRead.js";
import { createIndex, setHistoryDays, endOfDay } from "./tableIndex.js";
import { writePart } from "./tableWrite.js";
import { writePastDays } from "./pastDay.js";
import { bucketCount } from "./buckets.js";
import { readPartHeader } from "./codec.js";
import { StoreCheckError } from "./stateCheck.js";

const T = 30000;

async function copyEquals(h) {
  const out = {};
  for (let s = 0; s < bucketCount(h.index.copy); s++) for (const [k, v] of await readCopySlice(h.store, h.index, s)) out[k] = fmt(v);
  return out;
}

describe("fix 1: a second part on the copy day", () => {
  it("marks the copy stale; later nights rewrite it equal to the model", async () => {
    const h = new Harness({ rowsPerBucket: 3, copySpreadNights: 2 });
    await h.night(1, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`a${i}`, i + 1])));
    await h.night(2, { a0: 3 });
    h.index = startYearlyCopy(h.index, 2);
    for (const night of [3, 4]) h.index = (await runYearlyCopyNight({ store: h.store, index: h.index, night })).index;
    expect(copyStatus(h.index).complete).toBe(true);
    await h.night(2, { a0: 77 });
    expect(h.index.copy.version).toBe(2);
    expect(copyStatus(h.index).complete).toBe(false);
    for (const night of [5, 6]) h.index = (await runYearlyCopyNight({ store: h.store, index: h.index, night })).index;
    expect(copyStatus(h.index).complete).toBe(true);
    expect(await copyEquals(h)).toEqual(h.expected(2));
    expect((await copyEquals(h)).a0).toBe("77/0");
  }, T);
});

describe("fix 2: positions before what the index can rebuild", () => {
  async function pastHorizon() {
    const h = new Harness({ rowsPerBucket: 3, historyDays: 8, ageMarginDays: 2, ageSpreadDays: 2, copySpreadNights: 3 });
    for (let d = 1; d <= 20; d++) await h.night(d, { [`k${d % 6}`]: d, [`n${d}`]: 1 });
    return h;
  }

  it("rowsAt, readCurrentBucket and walkPosition throw a named error before the first kept part", async () => {
    const h = await pastHorizon();
    const early = endOfDay(h.index.carried.dropped - 1);
    await expect(rowsAt(h.store, h.index, early, 0)).rejects.toThrow(StoreCheckError);
    await expect(rowsAt(h.store, h.index, early, 0)).rejects.toThrow(/before the oldest position the index can rebuild/);
    await expect(readCurrentBucket(createReader(h.store, h.index), 0, early)).rejects.toThrow(StoreCheckError);
    const walk = async () => {
      for await (const b of walkPosition(h.store, h.index, early)) void b;
    };
    await expect(walk()).rejects.toThrow(StoreCheckError);
  }, T);

  it("the seed-185 shape: copy reset twice, the horizon passes the copy day, next night is unreachable and writes nothing", async () => {
    const h = new Harness({ rowsPerBucket: 3, historyDays: 8, ageMarginDays: 2, ageSpreadDays: 2, copySpreadNights: 3 });
    for (let d = 1; d <= 10; d++) await h.night(d, { [`k${d % 6}`]: d, [`n${d}`]: 1 });
    h.index = startYearlyCopy(h.index, 5);
    await h.past([[5, { k5: 500 }]]);
    await h.past([[5, { k5: 501 }], [6, { k1: 7 }]]);
    expect(h.index.copy.version).toBe(3);
    await h.night(11, { k1: 1 });
    await h.night(12, { k2: 2 });
    await h.night(13, { k3: 3 });
    expect(h.index.horizonStart).toBeGreaterThan(5);
    const r = await runYearlyCopyNight({ store: h.store, index: h.index, night: 13 });
    expect(r.status).toBe("unreachable");
    expect(r.written).toEqual([]);
    expect(Object.keys(r.index.copy.slices)).toEqual([]);
    expect(copyStatus(r.index).status).toBe("unreachable");
  }, T);

  it("rejects historyDays below the minimum and below ageMarginDays + copySpreadNights", () => {
    const base = { table: "t", fields: 2, rowsPerBucket: 4 };
    expect(() => createIndex({ ...base, historyDays: 370 })).toThrow(/historyDays 370 is below the minimum 371/);
    expect(createIndex(base).minHistoryDays).toBe(371);
    expect(() => createIndex({ ...base, historyDays: 40, minHistoryDays: 1 })).toThrow(/ageMarginDays \+ copySpreadNights/);
    const ok = createIndex({ ...base, historyDays: 400 });
    expect(() => setHistoryDays(ok, 300)).toThrow(/below the minimum/);
  });
});

// Counts which buckets' bases and part slices a call reads.
function countingStore(store) {
  const calls = { gets: [], ranges: [], bytes: 0 };
  return {
    calls,
    store: {
      ...store,
      async get(ref) {
        const b = await store.get(ref);
        calls.gets.push(ref);
        calls.bytes += b.length;
        return b;
      },
      async getRange(ref, off, len) {
        calls.ranges.push([ref, off]);
        calls.bytes += len;
        return store.getRange(ref, off, len);
      },
    },
  };
}

async function bucketsRead(h, calls, indexes) {
  const baseBucket = new Map();
  for (const idx of indexes) idx.buckets.forEach((b, j) => b.base && baseBucket.set(b.base.ref, j));
  const bases = new Set(calls.gets.map((r) => {
    if (!baseBucket.has(r)) throw new Error(`get of an item that is not a base: ${r}`);
    return baseBucket.get(r);
  }));
  const slices = new Set();
  for (const [ref, off] of calls.ranges) {
    if (off < 8 || baseBucket.has(ref)) continue;
    const header = await readPartHeader(h.store, ref);
    if (off === 8) continue; // the header itself
    for (const [b, s] of Object.entries(header.slices)) if (header.bodyStart + s.off === off) slices.add(Number(b));
  }
  return { bases: [...bases].sort((a, b) => a - b), slices: [...slices].sort((a, b) => a - b) };
}

describe("fix 3: a past-day write reads only the buckets it changes", () => {
  it("a one-day rewrite on 64 buckets reads the bases and slices of exactly 3 buckets", async () => {
    const layout = { L: 6, p: 0 };
    const h = new Harness({ rowsPerBucket: 1000 });
    const rows = {};
    for (let b = 0; b < 64; b++) for (const k of keysIn(b, layout, 3, `b${b}_`)) rows[k] = 1;
    await h.initial(1, layout, rows);
    const [k5] = keysIn(5, layout, 1, "b5_");
    const [k9] = keysIn(9, layout, 1, "b9_");
    const [k20] = keysIn(20, layout, 1, "b20_");
    await h.night(2, { [keysIn(30, layout, 1, "b30_")[0]]: 2 });
    await h.night(3, { [k5]: 3 });
    await h.night(4, { [k9]: 4 });
    await h.night(5, { [keysIn(40, layout, 1, "b40_")[0]]: 5 });
    const before = h.index;
    const { store, calls } = countingStore(h.store);
    const r = await writePastDays({ store, index: before, days: [{ day: 3, changes: new Map([[k5, [6n, 0n]], [k20, [7n, 0n]]]) }] });
    expect(await bucketsRead(h, calls, [before])).toEqual({ bases: [5, 9, 20], slices: [5, 9] });
    h.index = r.index;
    h.model.set(3, new Map([...h.modelOn(h.model, 2), [k5, "6/0"], [k20, "7/0"]]));
    h.snapshot();
    await h.verifyAll({ versions: [h.versions.at(-1)] });
  }, T);

  it("a range across a split reads only the split bucket's lineage and the changed buckets", async () => {
    const layout = { L: 6, p: 0 };
    const h = new Harness({ rowsPerBucket: 4 });
    const rows = {};
    for (let b = 0; b < 64; b++) for (const k of keysIn(b, layout, 4, `b${b}_`)) rows[k] = 1;
    await h.initial(1, layout, rows);
    await h.night(2, { [keysIn(30, layout, 1, "b30_")[0]]: 2 });
    const [extra] = keysIn(0, layout, 1, "x");
    const r3 = await h.night(3, { [extra]: 3 });
    expect(r3.split).toEqual({ split: 0, into: 64, L: 6 });
    const [k7a, k7b] = keysIn(7, layout, 2, "b7_");
    await h.night(4, { [k7a]: 4 });
    await h.night(5, { [k7b]: 5 });
    await h.night(6, { [keysIn(40, layout, 1, "b40_")[0]]: 6 });
    const before = h.index;
    const { store, calls } = countingStore(h.store);
    const changes3 = new Map([[extra, [9n, 0n]]]);
    const changes4 = new Map([[k7a, [8n, 0n]]]);
    const r = await writePastDays({ store, index: before, days: [{ day: 3, changes: changes3 }, { day: 4, changes: changes4 }] });
    const read = await bucketsRead(h, calls, [before]);
    expect(read.bases).toEqual([0, 7, 64]);
    expect(read.slices.every((b) => [0, 7, 64].includes(b))).toBe(true);
    h.index = r.index;
    const m2 = h.modelOn(h.model, 2);
    const m3 = new Map([...m2, [extra, "9/0"]]);
    h.model.set(3, m3);
    h.model.set(4, new Map([...m3, [k7a, "8/0"]]));
    h.snapshot();
    await h.verifyAll({ versions: [h.versions.at(-1)] });
  }, T);
});

describe("fix 4: a publish splits as many buckets as needed", () => {
  it("a day that triples the table ends with every bucket at or under 2R, reads equal the model", async () => {
    // R = 50 so hash variance stays inside 2R; at R = 4 one bucket of 27 held 10 rows.
    const R = 50;
    const h = new Harness({ rowsPerBucket: R });
    await h.night(1, Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`a${i}`, 1])));
    await h.night(2, Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`b${i}`, 2])));
    const r = await h.night(3, Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`c${i}`, 3])));
    expect(r.splits.length).toBeGreaterThan(1);
    expect(h.index.days.at(-1).parts[0].splits).toEqual(r.splits);
    const total = h.index.buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBeLessThanOrEqual(h.index.buckets.length * R);
    expect(h.index.buckets.every((b) => b.count <= 2 * R)).toBe(true);
    await h.night(4, { a0: 0, c0: 9 });
    const paths = await h.verifyAll();
    expect(paths.undo).toBeGreaterThan(0);
    expect((await changesOn(h.store, h.index, 3)).size).toBe(900);
    expect((await readState(h.store, h.index, 2)).state).toEqual(h.expected(2));
  }, T);
});

describe("fix 5: keys that are not well-formed Unicode", () => {
  it("rejects lone surrogates with a named error", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await expect(h.night(1, { "x\uD800": 1 })).rejects.toThrow(/key .* is not well-formed Unicode/);
    await expect(writePart({ store: h.store, index: h.index, day: 1, changes: new Map([["x\uDBFF", [1n, 0n]]]) })).rejects.toThrow(/not well-formed Unicode/);
  });
});

