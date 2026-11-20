// The table half of the lane's end step (design 2.1 section 9.1, end step 3): the new table file
// against the restored state, written as this publish's change file, with the bases and splits that
// are due (tableWrite.js decides which: 3.4 and 3.1).
//
// A table spec is what a table's format gives the lane (the codec of section 1, per table format; the
// real formats arrive with step 2.4, so the lane takes them as a seam):
//   { table, path, fields, rowsPerBucket, format }
//   path    the table file, repo-relative, as the bundle names it
//   format  readHeader(file) -> object        every field of the file that is not a row (JSON-able)
//           readRows(file) -> async iterable of [key, bigint[]]    one row each, key spelled by normKey
//           write(file, header, buckets)      writes the file from an async iterable of
//                                             { bucket, rows: Map } in increasing bucket order; the
//                                             format owns the order of rows inside its file and the
//                                             memory it needs to give the order it wants
//
// How the new file meets the restored state without holding either: the file is streamed once and
// its rows are spooled by bucket (the layout in force) into files of `spoolDir`, with a bounded write
// buffer (SPOOL_BUFFER_ROWS rows); a table with no stored state is streamed twice (the first pass counts
// the rows to choose the layout, layoutForRows). Then, bucket by bucket, the spooled new rows are loaded
// and compared with the restored rows (tableRead.rowsAt, state-checked), and only the rows that differ
// are kept, as a change (a key absent from the new file is a removal: all zeros).
// Memory: the new rows of one bucket plus the restored rows of the same bucket (each at most about
// 2R rows, design 3.1); the part goes through tableWrite.writePartBuckets, so the change rows of one
// bucket are held at a time (the compressed slices are kept until the part is put); the spool buffer is
// constant. `trace` (optional) is passed to writePartBuckets to count the change rows held.
// Cost: the table file is read once (twice for a first write), the spool is written and read once
// (about the file's size in text), and the store is read for the restored buckets and written for the
// change file and the due bases: the cost of design 14.2 per coin.
import fs from "node:fs/promises";
import path from "node:path";
import { bucketCount, bucketOf, layoutForRows } from "./buckets.js";
import { createIndex, lastDay } from "./tableIndex.js";
import { writeInitialTable, writePartBuckets } from "./tableWrite.js";
import { isZero } from "./stateCheck.js";
import { PackStepError, TableFormatError } from "./laneNames.js";

export const SPOOL_BUFFER_ROWS = 50_000;

function checkRow(slug, spec, key, value) {
  const ok = typeof key === "string" && key !== "" && key.isWellFormed() && Array.isArray(value) && value.length === spec.fields && value.every((x) => typeof x === "bigint");
  if (!ok) throw new TableFormatError(slug, "pack", `table ${spec.table}: a row of ${spec.path} is not [key, ${spec.fields} bigint fields] (key ${JSON.stringify(key)})`);
  if (isZero(value)) throw new TableFormatError(slug, "pack", `table ${spec.table}: key ${key} has an all-zero value in ${spec.path} (a zero row is not stored)`);
}

const spoolFile = (dir, b) => path.join(dir, `${b}.spool`);

async function spoolRows({ slug, spec, abs, layout, dir }) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const buffers = new Map();
  let buffered = 0;
  const flush = async () => {
    for (const [b, lines] of buffers) await fs.appendFile(spoolFile(dir, b), lines.join(""));
    buffers.clear();
    buffered = 0;
  };
  for await (const [key, value] of spec.format.readRows(abs)) {
    checkRow(slug, spec, key, value);
    const b = bucketOf(key, layout);
    if (!buffers.has(b)) buffers.set(b, []);
    buffers.get(b).push(`${JSON.stringify([key, value.map(String)])}\n`);
    if (++buffered >= SPOOL_BUFFER_ROWS) await flush();
  }
  await flush();
}

async function loadBucket({ slug, spec, dir, b }) {
  const rows = new Map();
  let text;
  try {
    text = await fs.readFile(spoolFile(dir, b), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return rows;
    throw err;
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const [key, v] = JSON.parse(line);
    if (rows.has(key)) throw new TableFormatError(slug, "pack", `table ${spec.table}: key ${key} appears twice in ${spec.path}`);
    rows.set(key, v.map(BigInt));
  }
  return rows;
}

async function countRows(spec, abs) {
  let n = 0;
  for await (const row of spec.format.readRows(abs)) n++;
  return n;
}

async function firstWrite({ slug, spec, abs, store, day, dir, indexOptions }) {
  const layout = layoutForRows(await countRows(spec, abs), spec.rowsPerBucket);
  await spoolRows({ slug, spec, abs, layout, dir });
  async function* buckets() {
    for (let b = 0; b < bucketCount(layout); b++) {
      const rows = await loadBucket({ slug, spec, dir, b });
      if (rows.size > 0) yield { bucket: b, rows };
    }
  }
  const index = createIndex({ table: spec.table, fields: spec.fields, rowsPerBucket: spec.rowsPerBucket, ...indexOptions });
  const res = await writeInitialTable({ store, index, day, layout, buckets: buckets() });
  return { index: res.index, stats: { first: true, changeRows: 0, basesWritten: res.index.buckets.filter((b) => b.base).length, splits: 0 } };
}

// The table's new rows as one bucket at a time for writePartBuckets: the spooled rows of bucket b, which
// replace the bucket (a restored key the file no longer has is removed there).
async function* freshBuckets({ slug, spec, dir, layout }) {
  for (let b = 0; b < bucketCount(layout); b++) yield { bucket: b, changes: await loadBucket({ slug, spec, dir, b }), replace: true };
}

// index: the table's index at the start, or null when the table has no stored state yet.
// day: the whole-number day of the part. Returns { index, header, stats }; `store` is the lane's
// table store (laneItems.js).
export async function packTable({ slug, spec, root, store, index, day, spoolDir, indexOptions, trace = null }) {
  const abs = path.resolve(root, spec.path);
  const dir = path.join(spoolDir, slug, spec.table);
  try {
    const header = await spec.format.readHeader(abs);
    if (index === null) return { header, ...(await firstWrite({ slug, spec, abs, store, day, dir, indexOptions })) };
    const last = lastDay(index);
    if (last !== null && day < last) throw new PackStepError(slug, "pack", `table ${spec.table}: day ${day} is before the newest indexed day ${last}; a past day is written by the past-day path, not by the nightly`);
    await spoolRows({ slug, spec, abs, layout: index.layout, dir });
    const res = await writePartBuckets({ store, index, day, buckets: freshBuckets({ slug, spec, dir, layout: index.layout }), trace });
    return { header, index: res.index, stats: { first: false, changeRows: res.rows, basesWritten: res.basesWritten.length, splits: res.splits.length } };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// What the bundle names of a table: the layout, the file's header and, per bucket, the base reference
// with the bucket's row count and state hash (design 3.1). Parts are named by the state index.
export function tableDescriptor(index, header) {
  return {
    L: index.layout.L, p: index.layout.p, header,
    buckets: index.buckets.map((b) => ({ base: b.base?.ref ?? null, count: b.count, hash: b.hash })),
  };
}
