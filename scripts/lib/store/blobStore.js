// The blob store of design 2.1 section 7.1: packs and other store-owned names on the
// five release series, behind one interface with two backends that behave and fail the
// same way (blobStoreFolder.js for tests and local runs, blobStoreRelease.js for GitHub):
//   upload(name, source) -> { name, size, loc }   the backend picks the release
//                                     source: Buffer, or { size, open() -> async iterable } (re-openable)
//   readRange(loc, offset, length)    -> Buffer; never lists
//   download(loc, sink, { parallel = 8, rangeBytes = 8 MiB })  sink: { write(off, buf), close?() }
//   stat(loc) -> { size, loc, createdAt?, state? } | null, exists(loc)   never list; createdAt and state
//                                     only where the backend knows them (the folder always; the release backend
//                                     after an upload or a listing of that release in this process)
//   listRelease(tag) -> { entries: [{ name, size, release, state, loc, createdAt }], requests }
//                                     the assets of one release, by name; a release that does not exist answers
//                                     no entries; `requests` is the core requests this call made
//   listReleaseTags(series) -> { releases: [{ tag, seq, createdAt }], requests }
//                                     the release tags that exist (empty ones too), no asset listing
//   delete(loc)                       the sweep's call; refuses names the store does not own and `keep`
//   list(series) -> [{ name, size, createdAt, release, state, loc }]
//   find(name) -> every entry with that name (cached series listing; refresh(series) clears it)
//   stats() -> { core, byKind }
//   releasesOf(series) -> [{ tag, seq, assets }]   every release of the series with its asset count,
//                                     empty ones included (list() shows assets only); no request when list() just ran
//   deleteRelease(tag)                the sweep's call for an empty release: refuses `keep`, unknown tags, and a
//                                     release that still holds an asset (StoreReleaseNotEmptyError)
// A location (`loc`) is "<release tag>/<name>" on both backends: the design's reference
// names the release beside the pack (section 1), and the manifest's pack table records
// it after the upload.
//
// Identity is the location. GitHub keeps one asset per name inside a release and nothing
// across releases, so the same name in two releases is two objects, and no call picks
// one of them by bare name (find returns them all). A stored location is never replaced:
// uploading a name into a release that already holds it returns that location when the
// bytes are equal (the retry of an upload that was stored and reported failed) and
// throws StoreNameTakenError, deleting nothing, when they differ.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { parseStoreName, parseReleaseTag, SERIES } from "./packNames.js";

export const ASSET_LIMIT = 900; // section 7.1; GitHub's own limit is 1,000
export const PARALLEL_RANGES = 8; // section 2: 400 MiB/s or more with 8 parallel ranges
export const RANGE_BYTES = 8 * 1024 * 1024;

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}
export class StoreNameError extends StoreError {}
export class StoreKeepError extends StoreError {}
export class StoreNotFoundError extends StoreError {}
export class StoreNameTakenError extends StoreError {}
export class StoreHttpError extends StoreError {}
export class StoreRateLimitError extends StoreError {}
export class StoreRangeError extends StoreError {}
export class StoreListingError extends StoreError {}
export class StoreUploadError extends StoreError {}
export class StoreReleaseNotEmptyError extends StoreError {}

// A release tag the sweep may delete: a store tag that is not the keep series.
export function ownedReleaseTag(tag) {
  let t;
  try { t = parseReleaseTag(tag); } catch { throw new StoreNameError(`not a release tag the store owns: ${JSON.stringify(tag)}`); }
  if (t.series === "keep") throw new StoreKeepError(`refused: release ${tag} is in the keep class`);
  return t;
}

// Any release tag of the store, the keep series included (a listing may read it).
export function checkTag(tag) {
  try {
    return parseReleaseTag(tag);
  } catch {
    throw new StoreNameError(`not a release tag the store owns: ${JSON.stringify(tag)}`);
  }
}

export function owned(name, { forDelete = false } = {}) {
  const p = parseStoreName(name);
  if (!p) throw new StoreNameError(`not a name the store owns: ${JSON.stringify(name)}`);
  // Section 4.1/4.2: no automatic rule deletes from `keep`.
  if (forDelete && p.series === "keep") throw new StoreKeepError(`refused: ${name} is in the keep class`);
  return p;
}

// "<release tag>/<name>", where the name belongs to the release's series.
export function parseLoc(loc) {
  const i = typeof loc === "string" ? loc.indexOf("/") : -1;
  if (i < 0) throw new StoreNameError(`not a location: ${JSON.stringify(loc)}`);
  const tag = loc.slice(0, i);
  const name = loc.slice(i + 1);
  let t;
  try { t = parseReleaseTag(tag); } catch { throw new StoreNameError(`not a location: ${JSON.stringify(loc)}`); }
  if (owned(name).series !== t.series) throw new StoreNameError(`${name} does not belong in ${tag}`);
  return { tag, name, series: t.series };
}

export function checkSeries(series) {
  if (!SERIES.includes(series)) throw new StoreNameError(`unknown series ${JSON.stringify(series)}`);
}

export function checkBounds(name, size, offset, length) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new StoreRangeError(`range ${offset}+${length} outside ${name} of ${size} bytes`);
  }
}

export const sizeOf = (source) => (Buffer.isBuffer(source) ? source.length : source.size);
export async function* chunksOf(source) {
  if (Buffer.isBuffer(source)) yield source;
  else yield* source.open();
}

// Streams the source once; a pack is never held whole for its hash.
export async function sha256Of(source) {
  const h = createHash("sha256");
  for await (const c of chunksOf(source)) h.update(c);
  return h.digest("hex");
}

// Reads a stored object sequentially in RANGE_BYTES pieces to hash it (retry path only).
export async function sha256ByRanges(readRange, loc, size) {
  const h = createHash("sha256");
  for (let off = 0; off < size; off += RANGE_BYTES) h.update(await readRange(loc, off, Math.min(RANGE_BYTES, size - off)));
  return h.digest("hex");
}

export function memorySink() {
  const parts = [];
  return {
    async write(off, buf) { parts.push([off, buf]); },
    bytes() {
      parts.sort((a, b) => a[0] - b[0]);
      return Buffer.concat(parts.map((p) => p[1]));
    },
  };
}

// Writes each range at its offset, so the whole pack is never held in memory.
export function fileSink(file) {
  let fh = null; // one open shared by the parallel writers
  const open = () => (fh ??= fs.open(file, "w"));
  return {
    async write(off, buf) { await (await open()).write(buf, 0, buf.length, off); },
    async close(size) { const h = await open(); await h.truncate(size); await h.close(); fh = null; },
  };
}

// Memory bound: `parallel` ranges of `rangeBytes` in flight.
export async function parallelDownload(readRange, loc, size, sink, { parallel = PARALLEL_RANGES, rangeBytes = RANGE_BYTES } = {}) {
  let next = 0;
  async function worker() {
    while (next < size) {
      const off = next;
      next += rangeBytes;
      await sink.write(off, await readRange(loc, off, Math.min(rangeBytes, size - off)));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  if (sink.close) await sink.close(size);
  return { size };
}

// Core requests (section 14.3) of the release backend, worst case with retries: each
// logical request is sent at most MAX_ATTEMPTS times; a listing is LIST_TRIES reads of
// its pages between two counts; a release holds at most 1,000 assets (11 pages).
export const MAX_ATTEMPTS = 4;
export const LIST_TRIES = 3;
const PAGES_PER_RELEASE = 11;
const LIST_RELEASE = LIST_TRIES * (PAGES_PER_RELEASE + 2) * MAX_ATTEMPTS;
const UPLOAD_ROUND = MAX_ATTEMPTS /* count */ + MAX_ATTEMPTS * 2 /* upload */ + LIST_RELEASE /* 422 */ + MAX_ATTEMPTS /* delete */ + MAX_ATTEMPTS /* recount */;
export const UPLOAD_ROUNDS = 3;
export const BUDGET = {
  // Without faults: 3 (1 count + 2 upload). Each full release passed on the way adds one
  // count; a repeat upload of a name this process posted adds one listing of that release.
  upload: UPLOAD_ROUNDS * UPLOAD_ROUND + LIST_RELEASE + MAX_ATTEMPTS,
  delete: MAX_ATTEMPTS, // without faults: 1, once the series listing is cached
  readRange: 0,
  download: 0,
  stat: 0, // by location; createdAt and state come from what this process already listed or uploaded
  exists: 0, // by location
  // find(name): the first call per series in a process costs listSeries, then 0.
  listRelease: LIST_RELEASE, // the assets of a release this process knows; without faults: pages + 2 (3 up to 100 assets)
  // The public listRelease(tag) also looks the release up when this process has not seen it
  // (without faults 1, a missing release answers after that one request).
  listReleaseByTag: MAX_ATTEMPTS + LIST_RELEASE,
  // listReleaseTags(series): one read of the repository's release list, no asset listing; without
  // faults pages + 2 (3 up to 100 releases in the repository). The folder backend: 0.
  listReleaseTags: (releasesInRepo) => (Math.ceil(releasesInRepo / 100) + 2) * LIST_TRIES * MAX_ATTEMPTS,
  // A series listing (list, or the first name lookup of a series in a process): every
  // page of the release list plus each of the series' releases; it grows with the
  // releases of the series, assets / 900. Repeated lookups hit the cache: 0.
  listSeries: (releasesInRepo, releasesInSeries) => (Math.ceil(releasesInRepo / 100) + 2) * LIST_TRIES * MAX_ATTEMPTS + releasesInSeries * LIST_RELEASE,
  newRelease: 2 * MAX_ATTEMPTS, // without faults: 1 tag lookup, then 1 create on 404
  // The first upload of a process into a series also reads the release list once, to find the newest release
  // (3 requests while the repository holds up to 100 releases); later uploads cost what they did.
  newestRelease: (releasesInRepo) => (Math.ceil(releasesInRepo / 100) + 2) * LIST_TRIES * MAX_ATTEMPTS,
  releasesOf: 0, // after list() of the series (a first call lists it)
  deleteRelease: 3 * MAX_ATTEMPTS, // without faults: 1 count, 1 delete (and 1 tag lookup when the release is not cached)
};
