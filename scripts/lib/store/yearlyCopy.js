// The yearly copy (design 2.1, section 6): the account table at the end of the copy
// day, cut by that day's bucket layout, written slice by slice over several nights.
// index.copy: { asOf, L, p, version, start, slices: { s: { ref, count, hash } } }.
// Night k = night - start; slice s is due from night (s mod spread) + 1, and each run
// writes every slice that is due or missing. start is null until the first run after
// a start or a restart, which then counts as night 1.
import { encodeBase, decodeBase } from "./codec.js";
import { bucketCount } from "./buckets.js";
import { ABSENT, dayEntry, endOfDay, layoutAt, readPosition } from "./tableIndex.js";
import { createReader, rowsAt } from "./tableRead.js";
import { hashRows, hashToHex, checkState, withContext } from "./stateCheck.js";

export function startYearlyCopy(index, asOf) {
  if (!dayEntry(index, asOf)) throw new Error(`yearly copy: day ${asOf} is not indexed`);
  const { L, p } = layoutAt(index, endOfDay(asOf));
  return { ...structuredClone(index), copy: { asOf, L, p, version: 1, start: null, slices: {} } };
}

// status: "none", "complete", "inProgress", or "unreachable" when slices are missing and
// the copy day has left the horizon: the caller must rebuild the copy another way (for
// example from the ledger); the store never writes a slice from another day's state.
export function copyStatus(index) {
  const c = index.copy;
  if (!c) return { status: "none", complete: false, missing: [] };
  const missing = [...Array(bucketCount(c)).keys()].filter((s) => !c.slices[s]);
  if (!missing.length) return { status: "complete", complete: true, missing };
  const status = readPosition(index, c.asOf) === ABSENT ? "unreachable" : "inProgress";
  return { status, complete: false, missing };
}

export async function runYearlyCopyNight({ store, index, night }) {
  if (!index.copy) throw new Error("yearly copy: none started");
  if (!Number.isInteger(night)) throw new Error(`yearly copy: night must be a whole number, got ${night}`);
  const before = copyStatus(index).status;
  if (before === "unreachable" || before === "complete") return { index, written: [], status: before };
  const idx = structuredClone(index);
  const copy = idx.copy;
  if (copy.start === null) {
    // First night after a start or a reset: a part on the copy day may have split
    // buckets, so the copy's layout is taken again from the end of that day.
    copy.start = night - 1;
    Object.assign(copy, layoutAt(idx, endOfDay(copy.asOf)));
  }
  const k = night - copy.start;
  const P = endOfDay(copy.asOf);
  const layout = { L: copy.L, p: copy.p };
  const reader = createReader(store, idx);
  const written = [];
  for (let s = 0; s < bucketCount(layout); s++) {
    if (copy.slices[s] || (s % idx.copySpreadNights) + 1 > k) continue;
    const { rows, count, hash } = await rowsAt(store, idx, P, s, reader);
    const header = { table: idx.table, fields: idx.fields, keyVersion: idx.keyVersion, bucket: s, layout, day: copy.asOf, part: 0, copyVersion: copy.version };
    const ref = await store.put(encodeBase({ header, rows }));
    copy.slices[s] = { ref, count, hash: hashToHex(hash) };
    written.push(s);
  }
  return { index: idx, written, status: copyStatus(idx).status };
}

export async function readCopySlice(store, index, s) {
  const c = index.copy;
  const rec = c?.slices[s];
  const ctx = { table: index.table, bucket: s, day: c?.asOf, part: "copy" };
  if (!rec) throw new Error(`yearly copy: slice ${s} not written`);
  const { rows } = await withContext(ctx, `copy slice ${rec.ref}`, async () => decodeBase(await store.get(rec.ref)));
  checkState(ctx, hashRows(rows), rec, "copy slice");
  return rows;
}
