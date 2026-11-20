// Writing a day's part (design 2.1, 3.1, 3.2, 3.4). Within one publish: apply the part's
// changes, rewrite the bases that are due, then split buckets one after another in
// linear-hashing order until the table is at most B·R rows (coordinator decision after
// the A1 review; each split is its own event in the part). A rewritten or split base
// takes the position of the part just written.
// Superseded bases are not returned for deletion: bases are cleaned up by reference,
// by the sweep of a later slice (design 4.3). Only dropped parts are returned here.
// Memory bound: writePartBuckets holds one bucket's change rows and current rows at a time;
// writePart(Map) is its wrapper and the caller then holds C.
import { assemblePart, encodeBase, encodePart, encodeSlice } from "./codec.js";
import { bucketCount, bucketOf, splitLayout } from "./buckets.js";
import {
  lastDay, currentPosition, endOfDay, dayEntry, advanceHorizon, emptyBucket, assertBucket, resetCopyIfOn,
} from "./tableIndex.js";
import { createReader, rowsAt } from "./tableRead.js";
import { rowHash, changeRowHash, addHash, subHash, hashToHex, hashRows, isZero, sameValue } from "./stateCheck.js";

function checkDay(day) {
  if (!Number.isInteger(day)) throw new Error(`store: day must be a whole number, got ${day}`);
}

export function checkChanges(index, changes) {
  if (!(changes instanceof Map)) throw new Error("store: changes must be a Map of key -> value");
  for (const [k, v] of changes) {
    if (typeof k !== "string" || k === "") throw new Error(`store: bad key ${String(k)}`);
    // A lone surrogate would encode to U+FFFD and collide with another key.
    if (!k.isWellFormed()) throw new Error(`store: key ${JSON.stringify(k)} is not well-formed Unicode`);
    if (!Array.isArray(v) || v.length !== index.fields || !v.every((x) => typeof x === "bigint")) {
      throw new Error(`store: value of ${k} must be ${index.fields} bigint fields`);
    }
  }
}

export async function writeBase(store, idx, entry, j, pos, rows, layout) {
  const { count, hash } = hashRows(rows);
  const header = { table: idx.table, fields: idx.fields, keyVersion: idx.keyVersion, bucket: j, layout, day: pos.day, part: pos.part };
  const ref = await store.put(encodeBase({ header, rows }));
  const record = { count, hash: hashToHex(hash) };
  idx.buckets[j] = { base: { ref, day: pos.day, part: pos.part, ...record }, ...record, changeRows: 0 };
  entry.checks[j] = record;
}

// Change rule or age rule (3.4); a bucket with no change since its base is never due.
function isDue(idx, j, day) {
  const b = idx.buckets[j];
  if (b.changeRows === 0) return false;
  if (!b.base || b.changeRows >= b.base.count) return true;
  return day - b.base.day >= idx.historyDays - idx.ageMarginDays - (j % idx.ageSpreadDays);
}

// The change rows of one bucket against its current state, with the bucket's new check record
// (null when nothing changed).
async function bucketChanges(store, idx, P, reader, b, changes, replace) {
  const cur = await rowsAt(store, idx, P, b, reader);
  let { count, hash } = cur;
  const rows = [];
  const zero = Array.from({ length: idx.fields }, () => 0n);
  const wanted = replace ? [...changes, ...[...cur.rows.keys()].filter((k) => !changes.has(k)).map((k) => [k, zero])] : changes;
  for (const [key, value] of wanted) {
    const old = cur.rows.get(key) ?? value.map(() => 0n);
    if (sameValue(old, value)) continue;
    rows.push({ key, old, new: value });
    if (!isZero(old)) [count, hash] = [count - 1, subHash(hash, rowHash(key, old))];
    if (!isZero(value)) [count, hash] = [count + 1, addHash(hash, rowHash(key, value))];
  }
  return rows.length ? { rows, check: { count, hash: hashToHex(hash) } } : null;
}

// Appends one part to `day`, one bucket at a time. `buckets` is an (async) iterable of
// { bucket, changes: Map key -> new value, replace? } (all zeros removes the row), each bucket once,
// every key in its bucket under the current layout. With `replace: true`, `changes` is the bucket's
// whole new content: a current key it lacks is removed (one read of the bucket does both). Memory: one bucket's change rows and its current rows
// at a time; each slice is compressed and only the compressed bytes are kept until the part is put.
// `trace({ bucket, held })` (optional) is called with the change rows held for each bucket, so a
// test can count the peak. Returns what writePart returns.
export async function writePartBuckets({ store, index, day, buckets, trace = null }) {
  checkDay(day);
  const last = lastDay(index);
  if (last !== null && day < last) throw new Error(`store: day ${day} is before the newest indexed day ${last}; use writePastDays`);
  const idx = structuredClone(index);
  const layout = idx.layout;
  const P = currentPosition(idx);
  const reader = createReader(store, idx);
  const header = { table: idx.table, fields: idx.fields, keyVersion: idx.keyVersion, day, part: 0, layout };
  const encoded = [];
  const checks = {};
  const sliceCounts = {};
  const seen = new Set();
  let rows = 0;
  let hash = 0n;
  for await (const { bucket: b, changes, replace = false } of buckets) {
    if (seen.has(b)) throw new Error(`store: bucket ${b} given twice`);
    seen.add(b);
    assertBucket(idx, b, layout);
    checkChanges(idx, changes);
    for (const k of changes.keys()) if (bucketOf(k, layout) !== b) throw new Error(`store: key ${k} is not in bucket ${b}`);
    const got = await bucketChanges(store, idx, P, reader, b, changes, replace);
    if (!got) continue;
    trace?.({ bucket: b, held: got.rows.length });
    const enc = encodeSlice(header, got.rows);
    encoded.push({ bucket: b, ...enc });
    checks[b] = got.check;
    sliceCounts[b] = enc.rows;
    rows += enc.rows;
    for (const r of got.rows) hash = addHash(hash, changeRowHash(r.key, r.old, r.new));
  }
  let entryDay = dayEntry(idx, day);
  const partNo = (entryDay?.parts.length ?? 0) + 1;
  const ref = await store.put(assemblePart({ header: { ...header, part: partNo }, encoded }));
  for (const b of Object.keys(sliceCounts)) {
    Object.assign(idx.buckets[b], checks[b]);
    idx.buckets[b].changeRows += sliceCounts[b];
  }
  const entry = { ref, rows, hash: hashToHex(hash), layout, layoutAfter: layout, splits: [], checks, slices: sliceCounts };
  if (!entryDay) {
    entryDay = { day, parts: [] };
    idx.days.push(entryDay);
  }
  entryDay.parts.push(entry);
  if (idx.horizonStart === null) idx.horizonStart = day;

  const pos = { day, part: partNo };
  resetCopyIfOn(idx, day);
  const { splits, basesWritten } = await rewriteAndSplit(store, idx, entry, pos);
  const droppedRefs = advanceHorizon(idx, day);
  return { index: idx, ref, rows, split: splits[0] ?? null, splits, basesWritten, droppedRefs };
}

// A part from a Map of every change (the caller holds all of C): the Map is cut by bucket and
// written by writePartBuckets.
export async function writePart({ store, index, day, changes }) {
  checkDay(day);
  checkChanges(index, changes);
  const groups = new Map();
  for (const [k, v] of changes) {
    const b = bucketOf(k, index.layout);
    if (!groups.has(b)) groups.set(b, new Map());
    groups.get(b).set(k, v);
  }
  const buckets = [...groups].sort(([x], [y]) => x - y).map(([bucket, c]) => ({ bucket, changes: c }));
  return writePartBuckets({ store, index, day, buckets });
}

async function rewriteAndSplit(store, idx, entry, pos) {
  const layout = idx.layout;
  const total = idx.buckets.reduce((s, b) => s + b.count, 0);
  const splitting = new Set();
  for (let l = layout; total > bucketCount(l) * idx.rowsPerBucket; l = splitLayout(l).layout) splitting.add(l.p);
  const P = endOfDay(pos.day);
  const reader = createReader(store, idx);
  const basesWritten = [];
  for (let j = 0; j < bucketCount(layout); j++) {
    if (splitting.has(j) || !isDue(idx, j, pos.day)) continue;
    const { rows } = await rowsAt(store, idx, P, j, reader);
    await writeBase(store, idx, entry, j, pos, rows, layout);
    basesWritten.push(j);
  }
  // The split bases are also the rewrite of each splitting bucket.
  const splits = [];
  while (total > bucketCount(idx.layout) * idx.rowsPerBucket) {
    const { rows } = await rowsAt(store, idx, P, idx.layout.p, reader);
    const { layout: next, event } = splitLayout(idx.layout);
    const parts = [new Map(), new Map()];
    for (const [k, v] of rows) parts[bucketOf(k, next) === event.split ? 0 : 1].set(k, v);
    idx.buckets.push(emptyBucket());
    await writeBase(store, idx, entry, event.split, pos, parts[0], next);
    await writeBase(store, idx, entry, event.into, pos, parts[1], next);
    idx.layout = next;
    entry.layoutAfter = next;
    splits.push(event);
    entry.splits = [...splits];
    basesWritten.push(event.split, event.into);
  }
  return { splits, basesWritten: [...new Set(basesWritten)].sort((a, b) => a - b) };
}

// First bases of an empty table under a layout the caller chose (for example with
// layoutForRows): bases at (day, 1) and a part with zero rows. buckets is an (async)
// iterable of { bucket, rows: Map }, one bucket at a time.
export async function writeInitialTable({ store, index, day, layout, buckets }) {
  checkDay(day);
  if (index.days.length || index.horizonStart !== null) throw new Error("store: writeInitialTable needs an empty index");
  const idx = structuredClone(index);
  idx.layout = layout;
  idx.carried.layout = layout;
  idx.buckets = Array.from({ length: bucketCount(layout) }, emptyBucket);
  const ref = await store.put(encodePart({ header: { table: idx.table, fields: idx.fields, keyVersion: idx.keyVersion, day, part: 1, layout }, slices: new Map() }));
  const entry = { ref, rows: 0, hash: hashToHex(0n), layout, layoutAfter: layout, splits: [], checks: {}, slices: {} };
  const seen = new Set();
  for await (const { bucket, rows } of buckets) {
    assertBucket(idx, bucket, layout);
    if (seen.has(bucket)) throw new Error(`store: bucket ${bucket} given twice`);
    seen.add(bucket);
    checkChanges(idx, rows);
    for (const [k, v] of rows) {
      if (bucketOf(k, layout) !== bucket) throw new Error(`store: key ${k} is not in bucket ${bucket}`);
      if (isZero(v)) throw new Error(`store: key ${k} has an all-zero value`);
    }
    await writeBase(store, idx, entry, bucket, { day, part: 1 }, rows, layout);
  }
  idx.days.push({ day, parts: [entry] });
  idx.horizonStart = day;
  return { index: idx, ref };
}

