// Test helpers for the store: a small harness that writes a table and keeps an
// independent model (one Map snapshot per indexed day) to compare every read with.
// Not a test file itself; imported by the *.test.js files beside it.
import { createMemoryStore } from "./itemStore.js";
import { createIndex, readPosition, lastDay } from "./tableIndex.js";
import { walkPosition, ABSENT } from "./tableRead.js";
import { writePart, writeInitialTable } from "./tableWrite.js";
import { writePastDays } from "./pastDay.js";
import { bucketOf, bucketCount } from "./buckets.js";

export const val = (a, s = 0) => [BigInt(a), BigInt(s)];
export const fmt = (v) => v.join("/");

// {A: 5, B: [3, 1]} -> Map of key -> [bigint, bigint]; 0 means removal.
export function changesOf(obj) {
  return new Map(Object.entries(obj).map(([k, x]) => [k, Array.isArray(x) ? x.map(BigInt) : val(x)]));
}

// {A: 5} -> {A: "5/0"}, the shape readState returns.
export function S(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, fmt(Array.isArray(x) ? x.map(BigInt) : val(x))]));
}

// Keys whose bucket under `layout` is `bucket`, named prefix0, prefix1, ...
export function keysIn(bucket, layout, n, prefix = "k") {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const key = `${prefix}${i}`;
    if (bucketOf(key, layout) === bucket) out.push(key);
  }
  return out;
}

export async function readState(store, index, day) {
  const pos = readPosition(index, day);
  if (pos === ABSENT) return { state: ABSENT, paths: { forward: 0, undo: 0 } };
  const state = {};
  const paths = { forward: 0, undo: 0 };
  for await (const b of walkPosition(store, index, pos)) {
    for (const [k, v] of b.rows) state[k] = fmt(v);
    paths.forward += b.paths.forward;
    paths.undo += b.paths.undo;
  }
  return { state, paths };
}

function applyObj(prev, changes) {
  const next = new Map(prev);
  for (const [k, v] of changes) {
    if (v.every((x) => x === 0n)) next.delete(k);
    else next.set(k, fmt(v));
  }
  return next;
}

// A test file may run the same sequences on another item store (packs): it sets this
// before importing the test files that use the Harness.
let itemStoreFactory = createMemoryStore;
export function setItemStoreFactory(factory) {
  itemStoreFactory = factory;
}

export class Harness {
  constructor(opts = {}) {
    this.store = itemStoreFactory();
    this.index = createIndex({ table: "acct", fields: 2, rowsPerBucket: 2, minHistoryDays: 1, copySpreadNights: 4, ...opts });
    this.model = new Map(); // day -> Map key -> "a/b", indexed days only
    this.versions = []; // { index, model } after each write
    this.dropped = [];
  }

  modelOn(model, day) {
    let best = null;
    for (const d of model.keys()) if (d <= day && (best === null || d > best)) best = d;
    return best === null ? new Map() : model.get(best);
  }

  snapshot() {
    this.versions.push({ index: this.index, model: new Map(this.model) });
  }

  async initial(day, layout, obj) {
    const changes = changesOf(obj);
    const groups = Array.from({ length: bucketCount(layout) }, () => new Map());
    for (const [k, v] of changes) groups[bucketOf(k, layout)].set(k, v);
    async function* buckets() {
      for (let b = 0; b < groups.length; b++) yield { bucket: b, rows: groups[b] };
    }
    const res = await writeInitialTable({ store: this.store, index: this.index, day, layout, buckets: buckets() });
    this.index = res.index;
    this.model.set(day, applyObj(new Map(), changes));
    this.snapshot();
    return res;
  }

  async night(day, obj = {}) {
    const changes = obj instanceof Map ? obj : changesOf(obj);
    const res = await writePart({ store: this.store, index: this.index, day, changes });
    this.index = res.index;
    this.dropped.push(...res.droppedRefs);
    this.model.set(day, applyObj(this.modelOn(this.model, day), changes));
    this.snapshot();
    if (this.verifyEachWrite) await this.verifyAll({ versions: [this.versions.at(-1)], fromDay: day });
    return res;
  }

  // list: [[day, obj], ...] consecutive days.
  async past(list) {
    const days = list.map(([day, obj]) => ({ day, changes: obj instanceof Map ? obj : changesOf(obj) }));
    const res = await writePastDays({ store: this.store, index: this.index, days });
    this.index = res.index;
    for (const { day, changes } of days) this.model.set(day, applyObj(this.modelOn(this.model, day - 1), changes));
    this.snapshot();
    if (this.verifyEachWrite) await this.verifyAll({ versions: [this.versions.at(-1)], fromDay: days[0].day - 1 });
    return res;
  }

  expected(day) {
    return Object.fromEntries(this.modelOn(this.model, day));
  }

  // Reads every day inside each version's horizon and compares with that version's model.
  // fromDay limits the days read (for the per-write check of the newest version).
  async verifyAll({ versions = this.versions, fromDay = -Infinity } = {}) {
    const paths = { forward: 0, undo: 0 };
    for (const v of versions) {
      const last = lastDay(v.index);
      const hs = v.index.horizonStart;
      for (let d = Math.max(hs - 2, fromDay); d <= last + 1; d++) {
        const got = await readState(this.store, v.index, d);
        if (d < hs) {
          if (got.state !== ABSENT) throw new Error(`day ${d} before horizonStart ${hs} did not read absent`);
          continue;
        }
        const want = Object.fromEntries(this.modelOn(v.model, d));
        try {
          expectEqual(got.state, want);
        } catch (err) {
          throw new Error(`version ending day ${last}, day ${d}: ${err.message}`);
        }
        paths.forward += got.paths.forward;
        paths.undo += got.paths.undo;
      }
    }
    return paths;
  }

  deleteDropped() {
    return Promise.all(this.dropped.map((ref) => this.store.delete(ref)));
  }
}

function expectEqual(got, want) {
  const a = JSON.stringify(Object.entries(got).sort());
  const b = JSON.stringify(Object.entries(want).sort());
  if (a !== b) throw new Error(`state differs\n got ${a}\nwant ${b}`);
}

// Small seeded generator (mulberry32) so a failing property run can be repeated.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
