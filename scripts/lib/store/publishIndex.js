// The state index rows of one coin that the publish job writes (design 2.1 section 9.2 step 3 and the
// contract in acceptChain.js: for every chain entry it publishes it writes a row for that entry's own
// day; references.js keeps a past day's bundle only through such a row or the current manifest entry).
//   row  = { day, part, bundle }      the shape references.js reads: `bundle` is the entry's bundle reference
//   file = { schema: 1, slug, rows }  `manifests/index/<slug>.json`, rows ascending by (day, part)
// Only the holders kind has rows (references.js, "What stays restorable"); the caller does not call
// this for another kind. `part` is 1 for the first row of a day and one more for each later row of the
// same day: a second publish of a day never replaces the first.
//
// A row is added once: an entry whose bundle already has a row (a re-run, a chain that overlaps an
// earlier publish) adds nothing. Rows older than the adoption window ending on the publish day are
// dropped on every write (nothing reads them: references.js asks for the window only), so a file holds
// at most one row per publish of the last 16 days.
//
// Cost by size: a row is about 0.3 KB, so a file is a few KB per coin and git grows with N and the
// publishes per day, never with H, C or D (the same bound as the manifests, section 8.3).
import { bundleKey, validateBundleRef } from "./bundle.js";
import { RecordSchemaError } from "./errors.js";
import { windowStart } from "./references.js";
import { parseRecord, shapeOf } from "./shape.js";
import { canonical, stableStringify } from "./stable.js";

export const INDEX_KIND = "holders";
export const INDEX_SCHEMA = 1;

function checkRow(row, slug) {
  const s = shapeOf(`index of ${slug}`);
  s.object(row, "row", ["day", "part", "bundle"]);
  s.day(row.day, "row.day");
  s.posint(row.part, "row.part");
  validateBundleRef(row.bundle, { slug, kind: INDEX_KIND });
  return row;
}

export function validateIndexFile(f, slug) {
  const s = shapeOf(`index of ${slug}`);
  s.object(f, "the record", ["schema", "slug", "rows"]);
  if (f.schema !== INDEX_SCHEMA) throw new RecordSchemaError(`index of ${slug}: schema ${JSON.stringify(f.schema)} is not readable here (this code reads schema ${INDEX_SCHEMA})`);
  if (f.slug !== slug) throw s.bad("slug", `is ${f.slug}, but the file is the index of ${slug}`);
  s.array(f.rows, "rows").forEach((row) => checkRow(row, slug));
  return f;
}

// The rows of a file's text.
export const parseIndexFile = (text, slug) => validateIndexFile(canonical(parseRecord(text, `index of ${slug}`, INDEX_SCHEMA)), slug).rows;

export const serializeIndexFile = (slug, rows) => `${stableStringify(validateIndexFile({ schema: INDEX_SCHEMA, slug, rows }, slug), 2)}\n`;

// The rows after publishing `entries` (oldest first) on `today` (a day). The argument is not changed.
export function addRows({ slug, rows, entries, today }) {
  rows.forEach((row) => checkRow(row, slug));
  const have = new Set(rows.map((r) => bundleKey(r.bundle)));
  const next = rows.map((r) => structuredClone(r));
  for (const entry of entries) {
    const key = bundleKey(entry.bundle);
    if (have.has(key)) continue;
    have.add(key);
    const part = 1 + Math.max(0, ...next.filter((r) => r.day === entry.day).map((r) => r.part));
    next.push(checkRow({ day: entry.day, part, bundle: structuredClone(entry.bundle) }, slug));
  }
  const from = windowStart(today);
  return next.filter((r) => r.day >= from).sort((a, b) => (a.day === b.day ? a.part - b.part : a.day < b.day ? -1 : 1));
}
