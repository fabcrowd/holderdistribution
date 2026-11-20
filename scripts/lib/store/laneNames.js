// Small shared facts of the lane steps (laneRestore.js, lanePack.js): the spelling of a stored
// blob's slice keys, calendar days as the whole numbers the table index uses, and the named
// errors of a coin that cannot go on tonight. Pure; no reads.
//
// A blob over BLOB_WHOLE_MAX bytes is stored as slices of SLICE_BYTES (design 9.1 end step 2).
// The bundle's `blobs` map holds one reference per slice under the key `<path>#slice.<n>`
// (n counted from 0), so the references of every slice are visible to the bundle's pack rows and
// to the sweep, as a whole blob's reference is. SLICE_MARKER is reserved: storeFiles.js refuses a
// file whose name holds it.
export const SLICE_MARKER = "#slice.";
export const BLOB_WHOLE_MAX = 16 * 1024 * 1024;
export const SLICE_BYTES = 8 * 1024 * 1024;
const SLICE_KEY = /^(.+)#slice\.(0|[1-9]\d*)$/;
const DAY_MS = 86_400_000;

export const sliceKey = (filePath, n) => `${filePath}${SLICE_MARKER}${n}`;

export function parseSliceKey(key) {
  const m = SLICE_KEY.exec(key);
  return m ? { path: m[1], n: Number(m[2]) } : null;
}

export const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

export class LaneCoinError extends Error {
  constructor(slug, stage, message, options) {
    super(`lane ${stage}: coin ${slug}: ${message}`, options);
    this.name = new.target.name;
    this.slug = slug;
    this.stage = stage;
  }
}
export class RestoreError extends LaneCoinError {}
export class PackStepError extends LaneCoinError {}
export class TableFormatError extends LaneCoinError {}

// An origin/main fact the lane needs is missing or malformed (laneCli.js fileGit). Not a coin's error
// when the file is the lane's (history, head commits, store.json): the lane stops, because a guess
// would start every coin from nothing.
export class OriginFactsError extends Error {
  constructor(message) {
    super(`origin facts: ${message}`);
    this.name = "OriginFactsError";
  }
}

// The same coin twice in one lane step: two bundles, one candidate entry would win.
export class DuplicateCoinError extends Error {
  constructor(slug) {
    super(`lane: coin ${slug} is named twice`);
    this.name = "DuplicateCoinError";
  }
}

// A file ended before the size it had when it was listed.
export class FileShrankError extends Error {
  constructor(file, wanted, got) {
    super(`lane: ${file} ended after ${got} of ${wanted} bytes`);
    this.name = "FileShrankError";
  }
}

// The report row of a coin that failed: the lane goes on with the next coin.
export const failedRow = (slug, err, stage = "unknown") => ({ status: "failed", slug, stage: err.stage ?? stage, error: err.name, message: err.message });

// A programming error is thrown out of the lane; every other error stops only the coin it is about
// (the rule of references.js: a failure to obtain or verify bytes is a coin's failure).
export const isProgrammingError = (err) => err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError;
