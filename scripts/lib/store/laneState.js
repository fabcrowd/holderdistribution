// The state index item and the start bundle, shared by the lane's start step (laneRestore.js) and
// end step (lanePack.js).
//
// The state index item (bundle.stateIndex, type "index"): { schema: 1, tables: { <table>: <table
// index of tableIndex.js> }, files: { <table>: { path, sha256 } }, packs: [pack rows] }. `packs` holds the row of every pack that a
// reference inside the table indexes names (bases, and the change files of every day inside the
// horizon). Why it is here and not in the bundle: a bundle may hold a row only for a pack one of its
// own references names (bundle.js checkPacks), and a bundle must not grow with the days of history;
// the change files' packs are named only inside the index, so the index carries their rows and a read
// of a past day resolves them without a listing. The index item lives in the bundle's own pack.
//
// openStart reads a coin's start bundle (the newest adopted entry, else the main entry) with
// `crossCheck: false`: two range reads. Every item it later gives is checked on read by the pack
// reader (raw size and sha256), and an adopted bundle was verified item by item by adoption.
import { bundleItems, ownPackRow, readBundle } from "./bundle.js";
import { refsIn } from "./itemRef.js";
import { RecordError } from "./errors.js";
import { canonical, stableStringify } from "./stable.js";
import { RestoreError } from "./laneNames.js";

export const STATE_INDEX_SCHEMA = 1;

// files: { <table>: { path, sha256 } }, the sha256 of the table file the generator produced when the
// state was packed. Restore compares it with the file it rebuilds (laneRestore.js): a format whose
// write is not byte-stable is caught there, not by the next night's diff.
export function serializeStateIndex({ tables, files, packs }) {
  return Buffer.from(stableStringify(canonical({ schema: STATE_INDEX_SCHEMA, tables, files, packs })), "utf8");
}

export function parseStateIndex(bytes, slug) {
  let v;
  try {
    v = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new RestoreError(slug, "start", `the state index is not JSON (${err.message})`, { cause: err });
  }
  const ok = v && v.schema === STATE_INDEX_SCHEMA && v.tables && typeof v.tables === "object" && v.files && typeof v.files === "object" && Array.isArray(v.packs);
  if (!ok) throw new RestoreError(slug, "start", `the state index has schema ${JSON.stringify(v?.schema)}, this code reads schema ${STATE_INDEX_SCHEMA}`);
  return v;
}

// The names of the packs a JSON value names by reference.
export const packNamesIn = (value) => new Set([...refsIn(value)].map((r) => r.slice(0, r.lastIndexOf("#"))));

// Rows (by pack name) of everything the start bundle can resolve: its own rows, its own pack,
// the index's rows.
export function knownRows(start) {
  if (!start) return new Map();
  const rows = [...start.bundle.packs, ownPackRow(start.bundleRef), ...(start.index?.packs ?? [])];
  return new Map(rows.map((r) => [r.name, r]));
}

// entry: the manifest entry (or adopted candidate entry) of the start. `bundle` may be given when
// adoption already read it. Returns null for a new coin (no entry).
export async function openStart({ blobs, slug, kind, entry, bundle = null, headers = null }) {
  if (!entry) return null;
  let read = bundle;
  try {
    read ??= await readBundle({ blobs, slug, kind, bundleRef: entry.bundle, expect: entry, crossCheck: false, headers });
  } catch (err) {
    if (err instanceof RecordError) throw new RestoreError(slug, "start", `cannot read the start bundle: ${err.message}`, { cause: err });
    throw err;
  }
  const items = bundleItems({ blobs, bundle: read, bundleRef: entry.bundle });
  let index = null;
  if (read.stateIndex !== null) {
    index = parseStateIndex(await items.get(read.stateIndex), slug);
    items.addRows(index.packs);
  }
  return { entry, bundle: read, bundleRef: entry.bundle, items, index };
}
