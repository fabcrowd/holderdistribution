// The two small pointer files next to the coin manifests (design 8.1):
//   data/manifests/store.json  { schema: 1, releases: { <series>: "<release tag>" } }
//       the release each series' lanes upload into; the publish job writes it taking, per
//       series, the maximum sequence number of `main` and of the run (9.2 step 4, 7.1)
//   data/manifests/site.json   { schema: 1, root: { name, release, size, sha256, parent } | null }
//       the current site root and the name of the one before it
// Parse with validation (not JSON or another schema is a RecordError, never an empty file),
// serialize with sorted keys and a trailing newline. Cost: a few hundred bytes; fixed.
import { RecordSchemaError } from "./errors.js";
import { NameError, SERIES, parseReleaseTag, parseSiteRootName } from "./packNames.js";
import { parseRecord, shapeOf } from "./shape.js";
import { canonical, stableStringify } from "./stable.js";

export const POINTER_SCHEMA = 1;

function tagField(s, tag, at, series) {
  let parsed;
  try {
    parsed = parseReleaseTag(tag);
  } catch (err) {
    if (err instanceof NameError) throw s.bad(at, `is not a release tag: ${err.message}`);
    throw err;
  }
  if (parsed.series !== series) throw s.bad(at, `is a ${parsed.series} release, expected a ${series} release`);
  return parsed;
}

function schemaCheck(label, v) {
  if (v.schema !== POINTER_SCHEMA) throw new RecordSchemaError(`${label}: schema ${JSON.stringify(v.schema)} is not readable here (this code reads schema ${POINTER_SCHEMA})`);
}

// --- store.json ---

export const emptyStoreFile = () => ({ schema: POINTER_SCHEMA, releases: {} });

export function validateStoreFile(f) {
  const s = shapeOf("store.json");
  s.object(f, "the record", ["schema", "releases"]);
  schemaCheck("store.json", f);
  s.map(f.releases, "releases", (tag, at, series) => {
    if (!SERIES.includes(series)) throw s.bad(at, `is not a series (one of ${SERIES.join(", ")})`);
    tagField(s, tag, at, series);
  });
  return f;
}

export const parseStoreFile = (text) => canonical(validateStoreFile(parseRecord(text, "store.json", POINTER_SCHEMA)));
export const serializeStoreFile = (f) => `${stableStringify(validateStoreFile(f), 2)}\n`;

// The maximum rule: per series, the release with the higher sequence number. A series
// one side lacks takes the other side's.
export function mergeStoreFiles(a, b) {
  validateStoreFile(a);
  validateStoreFile(b);
  const releases = {};
  for (const series of new Set([...Object.keys(a.releases), ...Object.keys(b.releases)])) {
    const x = a.releases[series];
    const y = b.releases[series];
    releases[series] = x === undefined ? y : y === undefined ? x : parseReleaseTag(x).seq >= parseReleaseTag(y).seq ? x : y;
  }
  return canonical({ schema: POINTER_SCHEMA, releases });
}

// --- site.json ---

const ROOT_KEYS = ["name", "release", "size", "sha256", "parent"];

export function validateSiteFile(f) {
  const s = shapeOf("site.json");
  s.object(f, "the record", ["schema", "root"]);
  schemaCheck("site.json", f);
  if (f.root === null) return f;
  s.object(f.root, "root", ROOT_KEYS);
  for (const [at, name] of [["root.name", f.root.name], ["root.parent", f.root.parent]]) {
    if (at === "root.parent" && name === null) continue;
    try {
      parseSiteRootName(name);
    } catch (err) {
      if (err instanceof NameError) throw s.bad(at, `is not a site root name: ${err.message}`);
      throw err;
    }
  }
  tagField(s, f.root.release, "root.release", "site");
  s.posint(f.root.size, "root.size");
  s.sha256(f.root.sha256, "root.sha256");
  return f;
}

export const parseSiteFile = (text) => canonical(validateSiteFile(parseRecord(text, "site.json", POINTER_SCHEMA)));
export const serializeSiteFile = (f) => `${stableStringify(validateSiteFile(f), 2)}\n`;
export const siteRootLoc = (root) => `${root.release}/${root.name}`;

export function buildSiteFile(root) {
  return canonical(validateSiteFile(structuredClone({ schema: POINTER_SCHEMA, root })));
}
