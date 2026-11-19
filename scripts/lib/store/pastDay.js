// Writing a past day or a range of past days (design 2.1, section 5). Each day of the
// range gets one part against the rebuilt day before it; the next indexed day e gets
// one replacement part so the end of e, and every later state, is unchanged.
// Only the affected groups are read: a group is every current bucket descended from one
// bucket of the layout before the range, and a group is affected when a key of the new
// changes or of the old parts of the range or of e falls in it. Every other bucket keeps
// its state over the range, so its bases keep their files and its records are carried.
// Cost grows with those keys (C), not with the table.
// Memory bound: one current bucket's states (before the range, while rolling forward,
// and at the end of e) at a time, plus the new change rows of the range and of e.
import { encodePart, readPartHeader, readPartSlice } from "./codec.js";
import { ancestorIn, bucketCount, bucketOf } from "./buckets.js";
import { dayEntry, layoutAt, endOfDay, recordAt, partLabel, recountChangeRows, resetCopyIfOn } from "./tableIndex.js";
import { createReader, readCurrentBucket } from "./tableRead.js";
import { writeBase, checkChanges } from "./tableWrite.js";
import { rowHash, changeRowHash, addHash, subHash, hashToHex, isZero, sameValue, checkState, withContext } from "./stateCheck.js";

function dayInfo(index, x) {
  const parts = dayEntry(index, x)?.parts ?? [];
  const lb = parts[0]?.layout ?? layoutAt(index, endOfDay(x - 1));
  return { parts, lb, la: parts.at(-1)?.layoutAfter ?? lb, splits: parts.flatMap((p) => p.splits) };
}

function addTo(acc, b, count, hash) {
  const cur = acc.get(b) ?? { count: 0, hash: 0n };
  acc.set(b, { count: cur.count + count, hash: addHash(cur.hash, hash) });
}

function push(map, b, row) {
  if (!map.has(b)) map.set(b, []);
  map.get(b).push(row);
}

function setRow(state, key, value) {
  const cur = state.rows.get(key);
  if (cur) [state.count, state.hash] = [state.count - 1, subHash(state.hash, rowHash(key, cur))];
  state.rows.delete(key);
  if (!isZero(value)) {
    state.rows.set(key, value);
    [state.count, state.hash] = [state.count + 1, addHash(state.hash, rowHash(key, value))];
  }
}

function validate(index, days) {
  if (!Array.isArray(days) || !days.length) throw new Error("writePastDays: no days given");
  days.forEach(({ day, changes }, i) => {
    if (!Number.isInteger(day) || (i && day !== days[i - 1].day + 1)) throw new Error("writePastDays: days must be consecutive whole numbers");
    checkChanges(index, changes);
  });
  const d1 = days[0].day;
  const d2 = days.at(-1).day;
  if (index.horizonStart === null || d1 < index.horizonStart) throw new Error(`writePastDays: day ${d1} is outside the horizon (starts ${index.horizonStart})`);
  const e = index.days.find((x) => x.day > d2)?.day;
  if (e === undefined) throw new Error(`writePastDays: no indexed day after ${d2}; write the newest day with writePart`);
  return { d1, d2, e };
}

// One current bucket: roll the range forward from the state before it, write bases
// positioned in the range or in e, and add the rows of e's replacement.
async function rebuildBucket(ctx, c) {
  const { store, old, idx, reader, days, e, info, byDay, out } = ctx;
  const prev = await readCurrentBucket(reader, c, ctx.Pprev);
  addTo(out.accPrev, ancestorIn(c, ctx.layoutPrev), prev.count, prev.hash);
  const state = { rows: prev.rows, count: prev.count, hash: prev.hash };
  const base = old.buckets[c].base;
  for (const { day: x } of days) {
    const { lb, la } = info.get(x);
    let touched = false;
    for (const [key, value] of byDay.get(x).get(c) ?? []) {
      const before = state.rows.get(key) ?? value.map(() => 0n);
      if (sameValue(before, value)) continue;
      push(out.slices.get(x), ancestorIn(c, lb), { key, old: before, new: value });
      setRow(state, key, value);
      touched = true;
    }
    if (touched) out.touched.get(x).add(ancestorIn(c, la));
    addTo(out.acc.get(x), ancestorIn(c, la), state.count, state.hash);
    if (base && base.day === x) await writeBase(store, idx, out.entries.get(x), c, { day: x, part: 1 }, state.rows, la);
  }
  const end = await readCurrentBucket(reader, c, ctx.PendE);
  addTo(out.accE, ancestorIn(c, ctx.layoutE), end.count, end.hash);
  const { lb, la, parts } = info.get(e);
  let touched = false;
  for (const key of new Set([...state.rows.keys(), ...end.rows.keys()])) {
    const zero = Array(old.fields).fill(0n);
    const a = state.rows.get(key) ?? zero;
    const b = end.rows.get(key) ?? zero;
    if (sameValue(a, b)) continue;
    push(out.slices.get(e), ancestorIn(c, lb), { key, old: a, new: b });
    touched = true;
  }
  if (touched) out.touched.get(e).add(ancestorIn(c, la));
  addTo(out.acc.get(e), ancestorIn(c, la), end.count, end.hash);
  if (base && base.day === e) {
    // A base at the old end of e keeps its rows (the end of e is unchanged).
    if (base.part === parts.length) idx.buckets[c].base = { ...base, part: 1 };
    else await writeBase(store, idx, out.entries.get(e), c, { day: e, part: 1 }, end.rows, la);
  }
  idx.buckets[c].count = old.buckets[c].count;
  idx.buckets[c].hash = old.buckets[c].hash;
}

function checkAcc(old, acc, P, layout, inGroup) {
  for (let b = 0; b < bucketCount(layout); b++) {
    if (!inGroup(b)) continue;
    const got = acc.get(b) ?? { count: 0, hash: 0n };
    checkState({ table: old.table, bucket: b, day: P.day, part: partLabel(old, P) }, got, recordAt(old, b, P), "rebuilt bucket");
  }
}

// Buckets of the layout before the range that hold a key of the new changes or of the
// old parts of the range and of e. Reads only the old parts' slices.
async function affectedRoots(store, old, targets, days, layoutPrev) {
  const roots = new Set();
  const add = (key) => roots.add(ancestorIn(bucketOf(key, old.layout), layoutPrev));
  for (const { changes } of days) for (const key of changes.keys()) add(key);
  for (const x of targets) {
    const parts = dayEntry(old, x)?.parts ?? [];
    for (let i = 0; i < parts.length; i++) {
      const ctx = { table: old.table, bucket: "all", day: x, part: i + 1 };
      const header = await withContext(ctx, `part header ${parts[i].ref}`, () => readPartHeader(store, parts[i].ref));
      for (const b of Object.keys(header.slices)) {
        const rows = await withContext({ ...ctx, bucket: Number(b) }, `part ${parts[i].ref} slice ${b}`, () => readPartSlice(store, parts[i].ref, header, Number(b)));
        for (const r of rows) add(r.key);
      }
    }
  }
  return roots;
}

// An unaffected bucket's state is the same over the range and e, so a base positioned
// there keeps its file and moves to part 1 of its day.
function keepBase(old, idx, c, targets) {
  const base = old.buckets[c].base;
  if (base && targets.includes(base.day)) idx.buckets[c].base = { ...base, part: 1 };
}

export async function writePastDays({ store, index, days }) {
  const { d1, d2, e } = validate(index, days);
  const old = index;
  const idx = structuredClone(index);
  const targets = [...days.map((x) => x.day), e];
  const info = new Map(targets.map((x) => [x, dayInfo(old, x)]));
  const byDay = new Map(days.map(({ day, changes }) => {
    const m = new Map();
    for (const [k, v] of changes) push(m, bucketOf(k, old.layout), [k, v]);
    return [day, m];
  }));
  const out = {
    accPrev: new Map(), accE: new Map(),
    acc: new Map(targets.map((x) => [x, new Map()])),
    slices: new Map(targets.map((x) => [x, new Map()])),
    touched: new Map(targets.map((x) => [x, new Set()])),
    entries: new Map(targets.map((x) => [x, { checks: {} }])),
  };
  const Pprev = endOfDay(d1 - 1);
  const PendE = endOfDay(e);
  const ctx = {
    store, old, idx, reader: createReader(store, old), days, e, info, byDay, out,
    Pprev, PendE, layoutPrev: layoutAt(old, Pprev), layoutE: layoutAt(old, PendE),
  };
  const roots = await affectedRoots(store, old, targets, days, ctx.layoutPrev);
  const inGroup = (b) => roots.has(ancestorIn(b, ctx.layoutPrev));
  for (let c = 0; c < bucketCount(old.layout); c++) {
    if (inGroup(c)) await rebuildBucket(ctx, c);
    else keepBase(old, idx, c, targets);
  }
  checkAcc(old, out.accPrev, Pprev, ctx.layoutPrev, inGroup);
  checkAcc(old, out.accE, PendE, ctx.layoutE, inGroup);

  for (const x of targets) {
    const { lb, la, splits } = info.get(x);
    const entry = out.entries.get(x);
    const oldRecords = info.get(x).parts.flatMap((p) => Object.keys(p.checks).map(Number));
    const recordSet = new Set([...out.touched.get(x), ...Object.keys(entry.checks).map(Number), ...oldRecords, ...splits.flatMap((s) => [s.split, s.into])]);
    for (const b of recordSet) {
      if (!inGroup(b)) {
        entry.checks[b] = recordAt(old, b, endOfDay(x)); // unchanged over the range
        continue;
      }
      const a = out.acc.get(x).get(b) ?? { count: 0, hash: 0n };
      entry.checks[b] = { count: a.count, hash: hashToHex(a.hash) };
    }
    const slices = out.slices.get(x);
    const ref = await store.put(encodePart({ header: { table: old.table, fields: old.fields, keyVersion: old.keyVersion, day: x, part: 1, layout: lb }, slices }));
    let rows = 0;
    let hash = 0n;
    const counts = {};
    for (const [b, list] of slices) {
      counts[b] = list.length;
      rows += list.length;
      for (const r of list) hash = addHash(hash, changeRowHash(r.key, r.old, r.new));
    }
    Object.assign(entry, { ref, rows, hash: hashToHex(hash), layout: lb, layoutAfter: la, splits, slices: counts });
    const at = idx.days.findIndex((y) => y.day >= x);
    if (idx.days[at].day === x) idx.days[at] = { day: x, parts: [entry] };
    else idx.days.splice(at, 0, { day: x, parts: [entry] });
  }
  recountChangeRows(idx);
  resetCopyIfOn(idx, d1, d2);
  return { index: idx };
}

