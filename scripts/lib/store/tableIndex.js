// The table index (design 2.1, 3.1, 3.2, 3.6): one JSON-serializable object the caller
// holds. Days are whole numbers. A position is { day, part } with part 1-based; the end
// of a day is { day, part: Infinity }, which is after every part of that day.
//
// index.days: [{ day, parts: [part] }] ascending. A part:
//   { ref, rows, hash, layout, layoutAfter, splits, checks: { bucket: { count, hash } }, slices: { bucket: rows } }
//   layout is the bucket function the part file is cut by (the one at its start); splits
//   are the split events done after it; checks are the state check records of every
//   bucket (under layoutAfter) it touched, split or wrote a base for.
// index.buckets[j]: { base: { ref, day, part, count, hash } | null, count, hash, changeRows }
//   count and hash are the bucket's current state; changeRows the change rows since the base.
// index.carried: the layout and the newest records of parts dropped from the horizon.
import { CODEC_VERSION } from "./codec.js";
import { bucketCount } from "./buckets.js";
import { StoreCheckError } from "./stateCheck.js";

export const ABSENT = "absent";
const ZERO_HASH = "0000000000000000";

export function createIndex(d) {
  if (!d || typeof d.table !== "string" || !d.table) throw new Error("createIndex: table name required");
  if (!Number.isInteger(d.fields) || d.fields < 1) throw new Error(`createIndex: bad field count ${d.fields}`);
  if (!Number.isInteger(d.rowsPerBucket) || d.rowsPerBucket < 1) throw new Error(`createIndex: bad rowsPerBucket ${d.rowsPerBucket}`);
  const layout = { L: 0, p: 0 };
  const index = {
    table: d.table,
    fields: d.fields,
    rowsPerBucket: d.rowsPerBucket,
    historyDays: d.historyDays ?? 400,
    minHistoryDays: d.minHistoryDays ?? 371,
    ageMarginDays: d.ageMarginDays ?? 30,
    ageSpreadDays: d.ageSpreadDays ?? 28,
    copySpreadNights: d.copySpreadNights ?? 28,
    codecVersion: CODEC_VERSION,
    keyVersion: d.keyVersion ?? 1,
    horizonStart: null,
    layout,
    buckets: [emptyBucket()],
    days: [],
    carried: { layout, records: {} },
    copy: null,
  };
  checkHistoryDays(index, index.historyDays);
  return index;
}

// historyDays is never below minHistoryDays (371 in the design, lowered only by tests),
// nor so short that a base rewrite margin plus a full yearly copy would outlive it.
function checkHistoryDays(index, historyDays) {
  if (!Number.isInteger(historyDays) || historyDays < 1) throw new Error(`table ${index.table}: bad historyDays ${historyDays}`);
  if (historyDays < index.minHistoryDays) {
    throw new Error(`table ${index.table}: historyDays ${historyDays} is below the minimum ${index.minHistoryDays}`);
  }
  if (historyDays < index.ageMarginDays + index.copySpreadNights) {
    throw new Error(`table ${index.table}: historyDays ${historyDays} is below ageMarginDays + copySpreadNights (${index.ageMarginDays + index.copySpreadNights})`);
  }
}

// The oldest position the index can still rebuild is the end of the last dropped day;
// any earlier position needs a dropped part. Throws a named error for such a position.
export function assertRebuildable(index, P, bucket) {
  const dropped = index.carried.dropped;
  if (dropped === undefined) return;
  if (P.day > dropped || (P.day === dropped && !Number.isFinite(P.part))) return;
  throw new StoreCheckError(
    { table: index.table, bucket, day: P.day, part: Number.isFinite(P.part) ? P.part : "end" },
    `position is before the oldest position the index can rebuild (end of day ${dropped})`,
  );
}

// A new part of the copy's day, or a rewrite of it, makes the copy stale (design 6).
// Mutates the caller's working copy.
export function resetCopyIfOn(index, fromDay, toDay = fromDay) {
  const c = index.copy;
  if (!c || c.asOf < fromDay || c.asOf > toDay) return;
  index.copy = { ...c, version: c.version + 1, slices: {}, start: null };
}

export const emptyBucket = () => ({ base: null, count: 0, hash: ZERO_HASH, changeRows: 0 });

export const cmpPos = (a, b) => a.day - b.day || a.part - b.part;
export const endOfDay = (day) => ({ day, part: Infinity });

export function lastDay(index) {
  return index.days.length ? index.days[index.days.length - 1].day : null;
}

export function currentPosition(index) {
  return endOfDay(lastDay(index) ?? 0);
}

export function dayEntry(index, day) {
  return index.days.find((x) => x.day === day) ?? null;
}

export function* partsInOrder(index) {
  for (const d of index.days) {
    for (let i = 0; i < d.parts.length; i++) yield { pos: { day: d.day, part: i + 1 }, entry: d.parts[i] };
  }
}

export function layoutAt(index, P) {
  let layout = index.carried.layout;
  for (const { pos, entry } of partsInOrder(index)) {
    if (cmpPos(pos, P) > 0) break;
    layout = entry.layoutAfter;
  }
  return layout;
}

export function splitsAfter(index, P) {
  const out = [];
  for (const { pos, entry } of partsInOrder(index)) if (cmpPos(pos, P) > 0) out.push(...entry.splits);
  return out;
}

// The newest state check record of `bucket` at or before P (design 3.6).
export function recordAt(index, bucket, P) {
  assertRebuildable(index, P, bucket);
  let found = null;
  for (const { pos, entry } of partsInOrder(index)) {
    if (cmpPos(pos, P) > 0) break;
    if (entry.checks[bucket]) found = entry.checks[bucket];
  }
  return found ?? index.carried.records[bucket] ?? { count: 0, hash: ZERO_HASH };
}

// The part number to name in an error for a read at P.
export function partLabel(index, P) {
  if (Number.isFinite(P.part)) return P.part;
  const d = dayEntry(index, P.day);
  return d ? d.parts.length : "end";
}

// A day before horizonStart (or before the first indexed day) is absent; any later day
// reads as the end of the last indexed day at or before it (design 3.3).
export function readPosition(index, day) {
  if (index.horizonStart === null || day < index.horizonStart) return ABSENT;
  if (!index.days.length) return ABSENT;
  if (day < index.days[0].day && index.carried.dropped === undefined) return ABSENT;
  return endOfDay(day);
}

export function setHistoryDays(index, historyDays) {
  checkHistoryDays(index, historyDays);
  return { ...structuredClone(index), historyDays };
}

// Moves horizonStart to today - historyDays + 1 (never backwards: raising historyDays
// extends the horizon only forward in time) and drops the index rows of older parts.
// A part a base still needs (a bucket with change rows since a base on or before it) is
// kept even when outside the horizon, as the sweep's second condition does (design 4.3).
// Mutates `index` (the caller's working copy); returns the refs no longer named.
export function advanceHorizon(index, today) {
  const target = today - index.historyDays + 1;
  index.horizonStart = Math.max(index.horizonStart ?? index.days[0]?.day ?? today, target);
  let keepFrom = index.horizonStart;
  for (const b of index.buckets) if (b.changeRows > 0 && b.base) keepFrom = Math.min(keepFrom, b.base.day);
  const dropped = [];
  while (index.days.length && index.days[0].day < keepFrom) {
    const d = index.days.shift();
    for (const part of d.parts) {
      index.carried.layout = part.layoutAfter;
      Object.assign(index.carried.records, part.checks);
      dropped.push(part.ref);
    }
    index.carried.dropped = d.day;
  }
  return dropped;
}

// Change rows since each base, from the parts' slice counts (design 5, step 5). Parts
// after a base are always cut by a layout in which that bucket exists.
export function recountChangeRows(index) {
  index.buckets.forEach((b, j) => {
    if (!b.base) {
      b.changeRows = 0;
      return;
    }
    let n = 0;
    for (const { pos, entry } of partsInOrder(index)) if (cmpPos(pos, b.base) > 0) n += entry.slices[j] ?? 0;
    b.changeRows = n;
  });
}

export function assertBucket(index, bucket, layout) {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= bucketCount(layout)) {
    throw new Error(`table ${index.table}: bucket ${bucket} not in layout L=${layout.L} p=${layout.p}`);
  }
}
