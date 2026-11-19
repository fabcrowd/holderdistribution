// The pack locations one coin still needs (design 4.3, first paragraph): the bundles of
// its current manifest entries for every kind, the bundles its state index rows of the
// adoption window name, and the packs those bundles name. The sweep keeps every pack whose
// location is in the set of a readable coin, and keeps every pack that lists an unreadable
// coin at all.
//
// The state index is the account table's (design section 1), so its rows belong to the
// holders kind. A row is { day, part, bundle }; per day only the newest row (the highest
// part) counts: an earlier publish of the same day is superseded and its bundle is not kept
// by this rule. The set is therefore the current entry of each kind (at most 3) plus one
// bundle per day of the window (at most 16): MAX_BUNDLES_PER_COIN = 19, enforced in code.
//
// What stays restorable (decided): only the holders kind has state index rows, so only
// holders bundles of past days in the adoption window stay restorable. A ledger or walletFlows
// bundle is kept through its kind's current manifest entry only, because nothing restores a
// past bundle of those kinds (the gap fill reads the account table, which is holders). An
// unpublished bundle of any kind is in no manifest and no row; it is protected only by the
// sweep's age wait (SWEEP_WAIT_DAYS), which the sweep slice enforces.
//
// Contract for the caller: a thrown error from coinReferences stops the whole cleanup for the
// night and deletes nothing. The caller must not catch per coin and carry on.
//
// A coin whose manifest, a bundle or the index cannot be read answers `unreadable` with the
// stage and the reason; it never answers a partial set that would look complete, because a
// sweep that trusted one would delete packs the coin still needs. A failure of a loader or of
// readBundle counts (a transient network error pins packs for a night, which is the safe
// side) and the error's name is kept in the answer. TypeError, ReferenceError and RangeError
// are programming errors: they are thrown, not folded into `unreadable`.
//
// Loader contract: loadIndexRows({ from, to }) returns only the rows of the window (the
// caller's index file is read by day, so this does not grow with D). A row outside the window
// is a loader bug and throws RangeError.
//
// Cost by size: the manifest, at most 19 bundles (each two range reads) and the window's
// rows. It grows with N (one call per coin) and with a coin's tables only through the size
// of its bundles (B buckets); never with D.
import { bundleKey, bundleLoc, referencedPacks, validateBundleRef } from "./bundle.js";
import { RecordShapeError } from "./errors.js";
import { validateManifest } from "./manifest.js";
import { KINDS } from "./packNames.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";
import { shapeOf, isDay } from "./shape.js";

export const MAX_BUNDLES_PER_COIN = KINDS.length + ADOPTION_WINDOW_DAYS;
const INDEX_KIND = "holders";
const PROGRAMMING_ERRORS = [TypeError, ReferenceError, RangeError];

// The first day of the window ending on `today`, which counts as one of its days.
export function windowStart(today) {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - (ADOPTION_WINDOW_DAYS - 1));
  return t.toISOString().slice(0, 10);
}

// Cannot fire through coinReferences: at most 3 manifest entries plus one row per day of a
// window of 16 (rows outside it throw earlier). It stays as an assertion of the bound.
function checkBundleCount(count, slug) {
  if (count > MAX_BUNDLES_PER_COIN) {
    throw new RangeError(`references of ${slug}: ${count} bundles to read, more than the ${MAX_BUNDLES_PER_COIN} one coin can need (kinds plus window days)`);
  }
}

function checkRow(row, slug, { from, to }) {
  const s = shapeOf(`index of ${slug}`);
  s.object(row, "row", ["day", "part", "bundle"]);
  s.day(row.day, "row.day");
  s.posint(row.part, "row.part");
  validateBundleRef(row.bundle, { slug, kind: INDEX_KIND });
  if (row.day < from || row.day > to) throw new RangeError(`index of ${slug}: the loader returned a row of ${row.day}, outside the window ${from} to ${to}`);
}

// One row per day: the highest part. Two rows of one (day, part) are ambiguous.
function newestPerDay(rows, slug) {
  const newest = new Map();
  for (const row of rows) {
    const held = newest.get(row.day);
    if (held && held.part === row.part) throw new RecordShapeError(`index of ${slug}: two rows for ${row.day} part ${row.part}`);
    if (!held || row.part > held.part) newest.set(row.day, row);
  }
  return [...newest.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export async function coinReferences({ slug, today, loadManifest, loadIndexRows, readBundle }) {
  const unreadable = (stage, err, extra = {}) => ({ status: "unreadable", slug, stage, ...extra, reason: err.message, errorName: err.name });
  async function attempt(stage, extra, fn) {
    try {
      return { value: await fn() };
    } catch (err) {
      if (PROGRAMMING_ERRORS.some((E) => err instanceof E)) throw err;
      return { failure: unreadable(stage, err, extra) };
    }
  }
  if (!isDay(today)) throw new RangeError(`coinReferences: today must be a calendar day, got ${JSON.stringify(today)}`);

  const m = await attempt("manifest", {}, async () => validateManifest(await loadManifest(), { slug }));
  if (m.failure) return m.failure;

  // One read per distinct bundle key; `reasons` collects why it is needed.
  const wanted = new Map();
  const want = (bundleRef, kind, day, expect, reason) => {
    const k = bundleKey(bundleRef);
    const w = wanted.get(k) ?? { bundleRef, kind, day, expect, reasons: [] };
    w.reasons.push(reason);
    wanted.set(k, w);
  };
  for (const kind of KINDS) {
    const entry = m.value.entries[kind];
    if (entry) want(entry.bundle, kind, null, entry, `manifest:${kind}`);
  }

  const window = { from: windowStart(today), to: today };
  const idx = await attempt("index", {}, async () => {
    const rows = await loadIndexRows(window);
    rows.forEach((row) => checkRow(row, slug, window));
    return newestPerDay(rows, slug);
  });
  if (idx.failure) return idx.failure;
  for (const row of idx.value) want(row.bundle, INDEX_KIND, row.day, null, `index:${row.day}`);
  checkBundleCount(wanted.size, slug);

  const bundles = [];
  for (const w of wanted.values()) {
    const r = await attempt("bundle", { kind: w.kind, ...(w.day ? { day: w.day } : {}) }, () => readBundle({ slug, kind: w.kind, bundleRef: w.bundleRef, ...(w.expect ? { expect: w.expect } : {}) }));
    if (r.failure) return r.failure;
    bundles.push({ ...w, bundle: r.value });
  }

  const why = new Map();
  const need = (loc, reason) => why.set(loc, [...(why.get(loc) ?? []), reason]);
  for (const b of bundles) {
    for (const reason of b.reasons) {
      need(bundleLoc(b.bundleRef), `${reason}:bundle`);
      for (const row of referencedPacks(b.bundle)) need(row.loc, `${reason}:refs`);
    }
  }
  for (const [loc, reasons] of why) why.set(loc, [...new Set(reasons)].sort());
  return { status: "ok", slug, locations: new Set(why.keys()), why };
}
