// The lane's start record of design 2.1 section 9.1 step 5, `start.json`, one per coin:
//   { schema: 1, slug, kind, parent, chain, usage, buckets }
//   parent   the full key of the coin's entry on main when the lane started (null: new coin)
//   chain    the adopted entries, oldest first, as candidate entries (no `publishedAt`)
//   usage    the usage of the newest start: the last chain entry, else the main entry; the run
//            builds its own usage on it with usage.js nextUsage (null: a new coin with no chain)
//   buckets  per table, the restored buckets' count and state hash, in increasing bucket order:
//            { <table>: [ { bucket, count, hash } ] }; `hash` is the 64-bit sum of design 3.6 as
//            16 lower-case hex digits. Nothing is restored in this slice: the caller passes what
//            the restore step checked.
// The record is the only thing the end step reads about the start: the candidate's chain is
// this chain plus the run's own entry, so the chain may hold at most ADOPTION_WINDOW_DAYS - 1
// entries (acceptChain refuses a published chain of more than the window).
//
// Cross-field rules are checked, not trusted: the first chain entry's parent is `parent`, each
// later one's is the entry before it, and `usage` is the newest start's. Writing is one small
// function: `<dir>/<slug>/start.json`, through a temporary file and a rename.
//
// Cost by size: KB per coin (a chain entry is about 0.7 KB; a bucket row about 50 bytes, B
// rows per table, 382 at H = 100 million); nothing grows with D or C.
import fs from "node:fs/promises";
import path from "node:path";
import { RecordSchemaError, RecordShapeError } from "./errors.js";
import { entryKey, validateEntry } from "./manifest.js";
import { kindField, parentField, slugField } from "./recordFields.js";
import { labelOf, parseRecord, shapeOf } from "./shape.js";
import { canonical, stableStringify } from "./stable.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";
import { validateUsage } from "./usage.js";

export const START_SCHEMA = 1;
export const START_FILE = "start.json";
const KEYS = ["schema", "slug", "kind", "parent", "chain", "usage", "buckets"];
const ROW_KEYS = ["bucket", "count", "hash"];
const STATE_HASH = /^[0-9a-f]{16}$/;
export const MAX_ADOPTED = ADOPTION_WINDOW_DAYS - 1;

function checkChain(s, r) {
  const chain = s.array(r.chain, "chain");
  if (chain.length > MAX_ADOPTED) {
    throw s.bad("chain", `holds ${chain.length} entries; the publish side refuses a chain of more than ${ADOPTION_WINDOW_DAYS}, and the run adds its own entry, so at most ${MAX_ADOPTED} can be adopted (own entry)`);
  }
  chain.forEach((entry, i) => {
    try {
      validateEntry(entry, { slug: r.slug, kind: r.kind, published: false });
    } catch (err) {
      if (err instanceof RecordShapeError) throw s.bad(`chain[${i}]`, `is not a candidate entry (${err.message})`);
      throw err;
    }
    const want = i === 0 ? r.parent : entryKey(chain[i - 1]);
    if (entry.parent !== want) throw s.bad(`chain[${i}].parent`, `is ${JSON.stringify(entry.parent)}, expected ${JSON.stringify(want)} (${i === 0 ? "the record's parent" : "the entry before it"})`);
  });
}

function checkUsage(s, r, label) {
  if (r.usage !== null) validateUsage(r.usage, label, "usage");
  if (r.chain.length > 0) {
    if (stableStringify(r.usage) !== stableStringify(r.chain.at(-1).usage)) throw s.bad("usage", "must be the usage of the newest start, the last chain entry");
  } else if (r.parent === null && r.usage !== null) {
    throw s.bad("usage", "must be null for a new coin with no chain");
  } else if (r.parent !== null && r.usage === null) {
    throw s.bad("usage", "must be the main entry's usage when the run starts from it (it is null)");
  }
}

function checkBuckets(s, buckets) {
  s.map(buckets, "buckets", (rows, at) => {
    s.array(rows, at).forEach((row, i) => {
      const where = `${at}[${i}]`;
      s.object(row, where, ROW_KEYS);
      s.uint(row.bucket, `${where}.bucket`);
      s.uint(row.count, `${where}.count`);
      s.match(row.hash, `${where}.hash`, STATE_HASH, "a 64-bit state hash (16 lower-case hex digits)");
      if (i > 0 && row.bucket <= rows[i - 1].bucket) throw s.bad(`${where}.bucket`, `is ${row.bucket}, not greater than the bucket before it (rows are in increasing bucket order, each bucket once)`);
    });
  });
}

export function validateStartRecord(r) {
  const probe = shapeOf("start record").isObject(r) ? r : {};
  const label = labelOf("start record", { slug: probe.slug, kind: probe.kind });
  const s = shapeOf(label);
  s.object(r, "the record", KEYS);
  if (r.schema !== START_SCHEMA) throw new RecordSchemaError(`${label}: schema ${JSON.stringify(r.schema)} is not readable here (this code reads schema ${START_SCHEMA})`);
  slugField(s, r.slug, "slug");
  kindField(s, r.kind, "kind");
  parentField(s, r.parent, "parent");
  checkChain(s, r);
  checkUsage(s, r, label);
  checkBuckets(s, r.buckets);
  return r;
}

// Tables in key order (canonical) and rows in bucket order, so equal facts give equal bytes.
function orderedBuckets(buckets) {
  if (buckets === null || typeof buckets !== "object" || Array.isArray(buckets)) return buckets;
  return Object.fromEntries(Object.entries(buckets).map(([table, rows]) => [
    table, Array.isArray(rows) ? structuredClone(rows).sort((a, b) => a.bucket - b.bucket) : rows,
  ]));
}

// `main` is the coin's published entry on main (null for a new coin), `chain` the adopted
// entries. The arguments are not changed.
export function buildStartRecord({ slug, kind, main, chain, buckets }) {
  if (main !== null) validateEntry(main, { slug, kind, published: true });
  const list = Array.isArray(chain) ? structuredClone(chain) : chain;
  const start = Array.isArray(list) && list.length > 0 ? list.at(-1) : main;
  const record = canonical({
    schema: START_SCHEMA, slug, kind, parent: main ? entryKey(main) : null, chain: list,
    usage: structuredClone(start?.usage ?? null), buckets: orderedBuckets(buckets),
  });
  return validateStartRecord(record);
}

export const serializeStartRecord = (r) => `${stableStringify(validateStartRecord(r), 2)}\n`;

export function parseStartRecord(input) {
  return canonical(validateStartRecord(parseRecord(input, "start record", START_SCHEMA)));
}

export async function writeStartRecord(dir, record) {
  const text = serializeStartRecord(record);
  const folder = path.join(dir, record.slug);
  const file = path.join(folder, START_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.mkdir(folder, { recursive: true });
  try {
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return file;
}

export async function readStartRecord(dir, slug) {
  slugField(shapeOf("start record"), slug, "slug");
  const record = parseStartRecord(await fs.readFile(path.join(dir, slug, START_FILE)));
  if (record.slug !== slug) throw new RecordShapeError(`start record ${slug}: the file holds the record of ${record.slug}`);
  return record;
}
