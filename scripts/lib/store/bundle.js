// A coin's bundle: its record for one kind and one run attempt (design 2.1 section 1 and
// 8.1). It is stored as one item in a `live` pack and named by a manifest entry through a
// bundle reference { ref, release, packSize, headerSha256, sha256 }: the item reference
// "<pack>#<id>", the release the pack is in, the pack's size and header hash (the same
// facts as a pack table row, so the pack opens with no listing), and the sha256 of the
// bundle's bytes. A read costs a pack stat (0 core requests), one header read and one item
// read; nothing is listed.
//
// Own pack: the bundle cannot hold the row of the pack it lives in (that row holds the
// pack's hash, which includes the bundle). `packs` holds a row for every OTHER pack the
// bundle's references name; a reference into the bundle's own pack resolves through the
// bundle reference. So at most one pack named by a reference may lack a row, and a reader
// checks that it is the bundle's own.
//
// A bundle is an item of type "bundle" labelled with its coin (writeBundle), so a pack's
// header lists the coin and adoption and the sweep find it. readBundle also cross-checks the
// labels of the bundle's items (bundleItemCheck.js): an item labelled with another coin is
// refused, and so is an unlabelled one unless `allowUnlabelled` (then it is counted in the report
// `onItemsChecked` gets). That adds one header range read per other pack the bundle names (fewer
// with a checked `parent`) and no API request; `crossCheck: false` is the read of the bundle
// alone (two range reads).
//
// Cost by size: a bundle holds one reference per blob (b per coin, under 2 MiB of blobs a
// night), one descriptor per table (about 120 bytes per bucket, so B per table, 1 at
// H = 100 thousand and 382 at 100 million) and one pack row per pack named (at most
// 16 coins share a pack, so about one row per coin and class per night plus the packs
// of carried bases). Nothing in a bundle grows with D or C; a reader's cost is the bundle
// reference's two range reads.
import { createPackItemStore } from "./packItemStore.js";
import { checkBundleItems } from "./bundleItemCheck.js";
import { parseReleaseTag, NameError } from "./packNames.js";
import { BundleBuildError, BundleReadError, BundleVerifyError, RecordSchemaError } from "./errors.js";
import { bundleKeyOf, packInfo, packNameOf, parseItemRef, refsIn } from "./itemRef.js";
import { kindField, packRowField, parentField, runField, slugField } from "./recordFields.js";
import { labelOf, parseRecord, shapeOf } from "./shape.js";
import { canonical, sha256Hex, stableStringify } from "./stable.js";
import { validateUsage } from "./usage.js";

export const BUNDLE_SCHEMA = 1;
const KEYS = ["schema", "slug", "kind", "day", "run", "parent", "usage", "blobs", "tables", "stateIndex", "packs"];
const REF_KEYS = ["ref", "release", "packSize", "headerSha256", "sha256"];

const refField = (s, v, at) => {
  if (!parseItemRef(v)) throw s.bad(at, `must be an item reference "<pack name>#<item id>", got ${JSON.stringify(v)}`);
};

function packsNamedByReferences(bundle) {
  const refs = refsIn([bundle.blobs, bundle.tables, bundle.stateIndex]);
  return new Set([...refs].map(packNameOf));
}

// The packs a reference names that have no row: at most the bundle's own pack.
export function unrowedPacks(bundle) {
  const rows = new Set(bundle.packs.map((p) => p.name));
  return new Set([...packsNamedByReferences(bundle)].filter((n) => !rows.has(n)));
}

function checkPacks(s, bundle) {
  const rows = s.array(bundle.packs, "packs");
  const names = rows.map((r, i) => (packRowField(s, r, `packs[${i}]`), r.name));
  for (let i = 1; i < names.length; i++) {
    if (names[i - 1] === names[i]) throw s.bad(`packs[${i}]`, `repeats the row of ${names[i]} (a reference resolves through one row)`);
    if (names[i - 1] > names[i]) throw s.bad(`packs[${i}]`, "is out of order (rows are sorted by name)");
  }
  const named = packsNamedByReferences(bundle);
  for (const name of names) if (!named.has(name)) throw s.bad("packs", `holds a row for ${name}, which no reference names`);
  const lacking = [...unrowedPacks(bundle)];
  if (lacking.length > 1) throw s.bad("packs", `lacks rows for ${lacking.join(", ")}; only the bundle's own pack may lack one`);
}

export function validateBundle(bundle, ctx = {}) {
  const probe = shapeOf("bundle").isObject(bundle) ? bundle : {};
  const s = shapeOf(labelOf("bundle", { slug: ctx.slug ?? probe.slug, kind: ctx.kind ?? probe.kind }));
  s.object(bundle, "the record", KEYS);
  if (bundle.schema !== BUNDLE_SCHEMA) throw new RecordSchemaError(`${labelOf("bundle", ctx)}: schema ${JSON.stringify(bundle.schema)} is not readable here (this code reads schema ${BUNDLE_SCHEMA})`);
  slugField(s, bundle.slug, "slug");
  kindField(s, bundle.kind, "kind");
  if (ctx.slug !== undefined && bundle.slug !== ctx.slug) throw s.bad("slug", `is ${bundle.slug}, expected ${ctx.slug}`);
  if (ctx.kind !== undefined && bundle.kind !== ctx.kind) throw s.bad("kind", `is ${bundle.kind}, expected ${ctx.kind}`);
  s.day(bundle.day, "day");
  runField(s, bundle.run, "run");
  parentField(s, bundle.parent, "parent");
  validateUsage(bundle.usage, labelOf("bundle", bundle), "usage");
  s.map(bundle.blobs, "blobs", (v, at) => refField(s, v, at));
  s.map(bundle.tables, "tables", (v, at) => {
    if (!s.isObject(v)) throw s.bad(at, "must be a table descriptor object");
  });
  if (bundle.stateIndex !== null) refField(s, bundle.stateIndex, "stateIndex");
  checkPacks(s, bundle);
  return bundle;
}

// Validates, copies and puts keys in canonical order; the argument is never changed.
export function buildBundle(fields) {
  const b = structuredClone({ schema: BUNDLE_SCHEMA, ...fields });
  if (Array.isArray(b.packs)) b.packs.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return canonical(validateBundle(b));
}

export function serializeBundle(bundle) {
  return Buffer.from(stableStringify(validateBundle(bundle)), "utf8");
}

export function parseBundle(input, ctx = {}) {
  const label = labelOf("bundle", ctx);
  return canonical(validateBundle(parseRecord(input, label, BUNDLE_SCHEMA), ctx));
}

// The rows of the packs this bundle's references name, except its own pack.
export function referencedPacks(bundle) {
  return structuredClone(bundle.packs);
}

// --- the reference a manifest entry holds ---

export function validateBundleRef(ref, { slug, kind } = {}) {
  const s = shapeOf(labelOf("bundle", { slug, kind }));
  s.object(ref, "bundle reference", REF_KEYS);
  refField(s, ref.ref, "bundle.ref");
  const info = packInfo(packNameOf(ref.ref));
  if (info.cls !== "live") throw s.bad("bundle.ref", `names a ${info.cls} pack; a bundle is stored in a live pack`);
  if (kind !== undefined && info.kind !== kind) throw s.bad("bundle.ref", `names a pack of kind ${info.kind}, expected ${kind}`);
  let tag;
  try {
    tag = parseReleaseTag(ref.release);
  } catch (err) {
    if (err instanceof NameError) throw s.bad("bundle.release", `is not a release tag: ${err.message}`);
    throw err;
  }
  if (tag.series !== "live") throw s.bad("bundle.release", `is a ${tag.series} release; a bundle is stored in a live release`);
  s.posint(ref.packSize, "bundle.packSize");
  s.sha256(ref.headerSha256, "bundle.headerSha256");
  s.sha256(ref.sha256, "bundle.sha256");
  return ref;
}

// The bundle's identity: what `parent` carries and what two entries are compared by.
export const bundleKey = (bundleRef) => bundleKeyOf(bundleRef);
export const bundleLoc = (bundleRef) => `${bundleRef.release}/${packNameOf(bundleRef.ref)}`;

// The pack table row of the bundle's own pack, as far as a read needs it.
export const ownPackRow = (bundleRef) => ({
  name: packNameOf(bundleRef.ref), loc: bundleLoc(bundleRef), size: bundleRef.packSize, headerSha256: bundleRef.headerSha256,
});

// --- writing and reading through a pack item store ---

// Puts the bundle as an item. The caller closes the store afterwards and passes the rows
// close() returns to bundleRefOf: only then is the pack's location known.
// The checks run in the store's `guard` before the item is added, with the name of the pack the
// bundle will land in, so a refused bundle leaves no item (and no open pack) behind: a reference
// that resolves to no row (for instance an item of a pack whose upload failed) is refused here.
export async function writeBundle(store, bundle) {
  const label = labelOf("bundle", bundle);
  const bytes = serializeBundle(bundle);
  const guard = (own) => {
    const lacking = [...unrowedPacks(bundle)].filter((n) => n !== own);
    if (lacking.length > 0) {
      throw new BundleBuildError(`${label}: its references name pack ${lacking[0]}, which has no row in the bundle and is not the pack ${own} the bundle will be put in (close the store that wrote it first and pass its rows)`);
    }
    if (bundle.packs.some((r) => r.name === own)) {
      throw new BundleBuildError(`${label}: it would be put in pack ${own}, which it already holds a row for (a bundle cannot hold the row of its own pack)`);
    }
  };
  const ref = await store.put(bytes, { type: "bundle", slug: bundle.slug, day: bundle.day }, { guard });
  return { ref, sha256: sha256Hex(bytes) };
}

export function bundleRefOf(put, closedRows) {
  const name = packNameOf(put.ref);
  const row = closedRows.find((r) => r.name === name);
  if (!row) throw new BundleBuildError(`bundle ${put.ref}: pack ${name} is not in the rows of the closed store (close the store before taking the reference)`);
  const ref = { ref: put.ref, release: row.loc.slice(0, row.loc.indexOf("/")), packSize: row.size, headerSha256: row.headerSha256, sha256: put.sha256 };
  return validateBundleRef(ref);
}

const readOnly = () => {
  throw new BundleReadError("bundle reader: this item store is read-only");
};

// An item store that resolves every reference of the bundle, from the bundle's own rows and
// its own pack: nothing else is needed to read a blob, a table base or the state index.
export function bundleItems({ blobs, bundle, bundleRef }) {
  return createPackItemStore({ blobs, nameFor: readOnly, packs: [...bundle.packs, ownPackRow(bundleRef)] });
}

function sameJson(a, b) {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

// Reads the bundle a manifest entry or an index row names, by location, and verifies it:
// the bytes hash to the reference's sha256, the bundle is this coin's and this kind's, and
// (when `expect` is an entry) its day, run and parent are the entry's; then (`crossCheck`, on by
// default) its items' labels, with the result { itemsChecked, unlabelled, packs, rangeReads }
// passed to `onItemsChecked`.
//
// `headers` is a header cache (packHeaderCache.js) a whole publish shares; `parent` is
// { bundle, bundleRef } of an already checked bundle of this coin, so the check reads only the
// items it does not name (bundleItemCheck.js); `allowUnlabelled` accepts items with no coin label.
export async function readBundle({ blobs, slug, kind, bundleRef, expect = null, crossCheck = true, onItemsChecked = null, headers = null, parent = null, allowUnlabelled = false }) {
  const label = labelOf("bundle", { slug, kind });
  validateBundleRef(bundleRef, { slug, kind });
  const items = createPackItemStore({ blobs, nameFor: readOnly, packs: [ownPackRow(bundleRef)], sharedHeaders: headers });
  let bytes;
  try {
    bytes = await items.get(bundleRef.ref);
  } catch (err) {
    throw new BundleReadError(`${label}: cannot read ${bundleRef.ref} at ${bundleLoc(bundleRef)}: ${err.message}`, { cause: err });
  }
  const got = sha256Hex(bytes);
  if (got !== bundleRef.sha256) throw new BundleVerifyError(`${label}: ${bundleRef.ref} has sha256 ${got}, its reference says ${bundleRef.sha256}`);
  const bundle = parseBundle(bytes);
  if (bundle.slug !== slug || bundle.kind !== kind) {
    throw new BundleVerifyError(`${label}: ${bundleRef.ref} is the bundle of ${bundle.slug}/${bundle.kind}`);
  }
  if (expect) {
    for (const f of ["day", "run", "parent", "usage"]) {
      if (!sameJson(bundle[f], expect[f])) throw new BundleVerifyError(`${label}: ${bundleRef.ref} has ${f} ${stableStringify(bundle[f])}, the entry says ${stableStringify(expect[f])}`);
    }
  }
  const own = packNameOf(bundleRef.ref);
  if (bundle.packs.some((r) => r.name === own)) throw new BundleVerifyError(`${label}: it holds a row for its own pack ${own}`);
  for (const name of unrowedPacks(bundle)) {
    if (name !== own) throw new BundleVerifyError(`${label}: a reference names pack ${name}, which has no row and is not its own pack ${own}`);
  }
  if (crossCheck) {
    items.addRows(bundle.packs);
    const readsOf = headers ? () => headers.stats().reads : undefined;
    const report = await checkBundleItems({ items, bundle, bundleRef, parent, ownRowOf: ownPackRow, allowUnlabelled, ...(readsOf ? { readsOf } : {}) });
    if (onItemsChecked) onItemsChecked(report);
  }
  return bundle;
}
