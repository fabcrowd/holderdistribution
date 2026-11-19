// Writing a day's part (design 2.1, 3.1, 3.2, 3.4). Within one publish: apply the part's
// changes, rewrite the bases that are due, then split buckets one after another in
// linear-hashing order until the table is at most B·R rows (coordinator decision after
// the A1 review; each split is its own event in the part). A rewritten or split base
// takes the position of the part just written.
// Superseded bases are not returned for deletion: bases are cleaned up by reference,
// by the sweep of a later slice (design 4.3). Only dropped parts are returned here.
// Memory bound: the part's own change rows (C) plus one bucket's rows at a time.
import { encodeBase, encodePart } from "./codec.js";
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

// Pass 1: the change rows of each touched bucket against its current state.
async function computeChanges(store, idx, changes) {
  const layout = idx.layout;
  const groups = new Map();
  for (const [k, v] of changes) {
    const b = bucketOf(k, layout);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push([k, v]);
  }
  const P = currentPosition(idx);
  const reader = createReader(store, idx);
  const slices = new Map();
  const checks = {};
  for (const b of [...groups.keys()].sort((x, y) => x - y)) {
    const cur = await rowsAt(store, idx, P, b, reader);
    let { count, hash } = cur;
    const rows = [];
    for (const [key, value] of groups.get(b)) {
      const old = cur.rows.get(key) ?? value.map(() => 0n);
      if (sameValue(old, value)) continue;
      rows.push({ key, old, new: value });
      if (!isZero(old)) [count, hash] = [count - 1, subHash(hash, rowHash(key, old))];
      if (!isZero(value)) [count, hash] = [count + 1, addHash(hash, rowHash(key, value))];
    }
    if (!rows.length) continue;
    slices.set(b, rows);
    checks[b] = { count, hash: hashToHex(hash) };
  }
  return { slices, checks };
}

// Appends one part to `day` (the newest indexed day or a later one). changes: Map
// key -> new value (all zeros removes the row); old values come from the current state.
export async function writePart({ store, index, day, changes }) {
  checkDay(day);
  checkChanges(index, changes);
  const last = lastDay(index);
  if (last !== null && day < last) throw new Error(`store: day ${day} is before the newest indexed day ${last}; use writePastDays`);
  const idx = structuredClone(index);
  const layout = idx.layout;
  const { slices, checks } = await computeChanges(store, idx, changes);
  let entryDay = dayEntry(idx, day);
  const partNo = (entryDay?.parts.length ?? 0) + 1;
  const ref = await store.put(encodePart({ header: { table: idx.table, fields: idx.fields, keyVersion: idx.keyVersion, day, part: partNo, layout }, slices }));
  let rows = 0;
  let hash = 0n;
  const sliceCounts = {};
  for (const [b, list] of slices) {
    sliceCounts[b] = list.length;
    rows += list.length;
    for (const r of list) hash = addHash(hash, changeRowHash(r.key, r.old, r.new));
    Object.assign(idx.buckets[b], checks[b]);
    idx.buckets[b].changeRows += list.length;
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

