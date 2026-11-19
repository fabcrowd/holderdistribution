// Reading present and past days (design 2.1, 3.3) with the state check (3.6).
// Memory bound: a read holds one current bucket's rows (at most about 2R) plus, for a
// past bucket that has split since, the rows of its lineage, which together are that
// one past bucket's rows. Nothing holds a whole table.
import { decodeBase, readPartHeader, readPartSlice } from "./codec.js";
import { ancestorIn, bucketCount, bucketOf, lineage } from "./buckets.js";
import {
  ABSENT, cmpPos, partsInOrder, layoutAt, splitsAfter, recordAt, partLabel, readPosition, dayEntry, assertBucket, assertRebuildable,
} from "./tableIndex.js";
import {
  StoreCheckError, checkState, withContext, hashRows, rowHash, changeRowHash, addHash, subHash, hashToHex, isZero, sameValue,
} from "./stateCheck.js";

export { ABSENT };

export function createReader(store, index) {
  const headers = new Map();
  return {
    store,
    index,
    async header(ref, ctx) {
      if (!headers.has(ref)) headers.set(ref, await withContext(ctx, `part header ${ref}`, () => readPartHeader(store, ref)));
      return headers.get(ref);
    },
  };
}

async function loadBase(reader, c) {
  const { store, index } = reader;
  const base = index.buckets[c].base;
  if (!base) return { rows: new Map(), count: 0, hash: 0n };
  const ctx = { table: index.table, bucket: c, day: base.day, part: base.part };
  const { header, rows } = await withContext(ctx, `base ${base.ref}`, async () => decodeBase(await store.get(base.ref)));
  if (header.table !== index.table || header.bucket !== c) {
    throw new StoreCheckError(ctx, `base ${base.ref} is for table ${header.table} bucket ${header.bucket}`);
  }
  const { count, hash } = hashRows(rows);
  checkState(ctx, { count, hash }, base, "base reference");
  return { rows, count, hash };
}

// Applies (forward) or undoes one part's rows for current bucket c onto `state`.
async function applyPart(reader, state, c, pos, entry, undo) {
  const { store, index } = reader;
  if (!entry.checks[ancestorIn(c, entry.layoutAfter)]) return; // the part did not touch c's keys
  const ctx = { table: index.table, bucket: c, day: pos.day, part: pos.part };
  const header = await reader.header(entry.ref, ctx);
  const slice = ancestorIn(c, entry.layout);
  const rows = await withContext(ctx, `part ${entry.ref} slice ${slice}`, () => readPartSlice(store, entry.ref, header, slice));
  const list = undo ? [...rows].reverse() : rows;
  for (const row of list) {
    if (bucketOf(row.key, index.layout) !== c) continue;
    const [from, to] = undo ? [row.new, row.old] : [row.old, row.new];
    const cur = state.rows.get(row.key);
    const curValue = cur ?? from.map(() => 0n);
    if (!sameValue(curValue, from)) {
      throw new StoreCheckError(ctx, `key ${row.key}: ${undo ? "new" : "old"} value ${from.join("/")} differs from the current row ${curValue.join("/")}`);
    }
    if (cur) {
      state.hash = subHash(state.hash, rowHash(row.key, cur));
      state.count--;
      state.rows.delete(row.key);
    }
    if (!isZero(to)) {
      state.rows.set(row.key, to);
      state.hash = addHash(state.hash, rowHash(row.key, to));
      state.count++;
    }
  }
}

// One current bucket's rows at position P: its base plus the parts after the base up to
// P, or its base with the parts after P undone, last part first.
export async function readCurrentBucket(reader, c, P) {
  const { index } = reader;
  assertRebuildable(index, P, c);
  const state = await loadBase(reader, c);
  const base = index.buckets[c].base;
  const basePos = base ? { day: base.day, part: base.part } : { day: -Infinity, part: 0 };
  const undo = cmpPos(basePos, P) > 0;
  const parts = [];
  for (const p of partsInOrder(index)) {
    const inRange = undo ? cmpPos(p.pos, P) > 0 && cmpPos(p.pos, basePos) <= 0 : cmpPos(p.pos, basePos) > 0 && cmpPos(p.pos, P) <= 0;
    if (inRange) parts.push(p);
  }
  if (undo) parts.reverse();
  for (const { pos, entry } of parts) await applyPart(reader, state, c, pos, entry, undo);
  return { ...state, path: undo ? "undo" : "forward" };
}

export function bucketsAt(index, P) {
  const layout = layoutAt(index, P);
  return { layout, buckets: [...Array(bucketCount(layout)).keys()] };
}

// Bucket j of the layout at P, rebuilt from the current buckets on its lineage, then
// checked against the newest record at or before P. The lineage partitions j's keys,
// so no key filter is needed.
export async function rowsAt(store, index, P, j, reader = createReader(store, index)) {
  assertRebuildable(index, P, j);
  assertBucket(index, j, layoutAt(index, P));
  const rows = new Map();
  let count = 0;
  let hash = 0n;
  const paths = { forward: 0, undo: 0 };
  for (const c of lineage(j, splitsAfter(index, P))) {
    const part = await readCurrentBucket(reader, c, P);
    for (const [k, v] of part.rows) rows.set(k, v);
    count += part.count;
    hash = addHash(hash, part.hash);
    paths[part.path]++;
  }
  const ctx = { table: index.table, bucket: j, day: P.day, part: partLabel(index, P) };
  checkState(ctx, { count, hash }, recordAt(index, j, P), "rebuilt bucket");
  return { rows, count, hash, paths };
}

// Yields every bucket of the layout at P, one at a time.
export async function* walkPosition(store, index, P) {
  const reader = createReader(store, index);
  for (const j of bucketsAt(index, P).buckets) yield { bucket: j, ...(await rowsAt(store, index, P, j, reader)) };
}

// The net change of one day: Map key -> { old, new }, keys whose value did not change
// over the day left out. Reads only that day's parts. Memory grows with that day's C.
export async function changesOn(store, index, day) {
  if (readPosition(index, day) === ABSENT) return ABSENT;
  const out = new Map();
  const entry = dayEntry(index, day);
  if (!entry) return out;
  const seen = new Set();
  for (let i = 0; i < entry.parts.length; i++) {
    const part = entry.parts[i];
    const ctx = { table: index.table, bucket: "all", day, part: i + 1 };
    if (seen.has(part.ref)) throw new StoreCheckError(ctx, `part ${part.ref} listed twice in the index`);
    seen.add(part.ref);
    const header = await withContext(ctx, `part header ${part.ref}`, () => readPartHeader(store, part.ref));
    let rows = 0;
    let hash = 0n;
    for (const b of Object.keys(header.slices)) {
      const sctx = { ...ctx, bucket: Number(b) };
      const slice = await withContext(sctx, `part ${part.ref} slice ${b}`, () => readPartSlice(store, part.ref, header, Number(b)));
      for (const row of slice) {
        rows++;
        hash = addHash(hash, changeRowHash(row.key, row.old, row.new));
        const prev = out.get(row.key);
        if (prev && !sameValue(prev.new, row.old)) {
          throw new StoreCheckError(sctx, `key ${row.key}: old value ${row.old.join("/")} differs from the previous part's ${prev.new.join("/")}`);
        }
        out.set(row.key, { old: prev ? prev.old : row.old, new: row.new });
      }
    }
    if (rows !== part.rows || hashToHex(hash) !== part.hash) {
      throw new StoreCheckError(ctx, `part file has ${rows} rows hash ${hashToHex(hash)}, index records ${part.rows} rows hash ${part.hash}`);
    }
  }
  for (const [k, x] of out) if (sameValue(x.old, x.new)) out.delete(k);
  return out;
}
