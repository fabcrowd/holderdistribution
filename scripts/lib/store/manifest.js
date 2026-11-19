// The coin manifest of design 8.1, `data/manifests/<slug>.json`, in git:
//   { schema: 1, slug, entries: { <kind>: entry } }
//   entry = { bundle: bundleRef, parent, day, run, publishedAt, usage }
// `bundle` is the reference bundle.js defines: { ref, release, packSize, headerSha256,
// sha256 }. With the release and the pack name in `ref`, a reader builds the location
// "<release>/<pack name>" and reads the bundle with no listing; `packSize` and
// `headerSha256` make that pack open as a verified pack table row; `sha256` is the
// bundle's own hash. A stored location is never replaced (blobStore.js), so the release is
// part of the identity. `parent` is the parent bundle's full key
// "<release>/<pack name>#<item id>@<sha256>" (bundle.js `bundleKey`), not the design's
// "<pack name>#<slug>": up to 16 coins share a pack and a pack name can exist in two releases,
// so only the full key names one bundle.
//
// An entry of a candidate chain has no `publishedAt`: the publish job adds it when the
// entry becomes the manifest's (design 9.2 step 4).
//
// A manifest that is not valid JSON or has another schema is a RecordError, which callers
// treat as an unreadable coin and never as an empty one (design 9.2 step 3, 10(j)).
//
// Cost by size: one entry per kind, about 0.7 KB with its usage; it changes once per
// publish per kind, so git grows with N and the publishes per day, never with H, C or D.
import { RecordSchemaError, RecordShapeError } from "./errors.js";
import { bundleKey, validateBundleRef } from "./bundle.js";
import { KINDS } from "./packNames.js";
import { kindField, parentField, runField, slugField } from "./recordFields.js";
import { labelOf, parseRecord, shapeOf } from "./shape.js";
import { canonical, stableStringify } from "./stable.js";
import { validateUsage } from "./usage.js";

export const MANIFEST_SCHEMA = 1;
const ENTRY_KEYS = ["bundle", "parent", "day", "run", "usage"];
const PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function validateEntry(entry, { slug, kind, published = true }) {
  const s = shapeOf(labelOf("manifest entry", { slug, kind }));
  s.object(entry, "entry", published ? [...ENTRY_KEYS, "publishedAt"] : ENTRY_KEYS);
  validateBundleRef(entry.bundle, { slug, kind });
  parentField(s, entry.parent, "parent");
  s.day(entry.day, "day");
  runField(s, entry.run, "run");
  validateUsage(entry.usage, labelOf("manifest entry", { slug, kind }), "usage");
  if (published) {
    s.match(entry.publishedAt, "publishedAt", PUBLISHED_AT, "a UTC time (YYYY-MM-DDTHH:MM:SSZ)");
    if (Number.isNaN(Date.parse(entry.publishedAt))) throw s.bad("publishedAt", `is not a time: ${entry.publishedAt}`);
  }
  return entry;
}

// The entry a lane proposes for one bundle: its facts are the bundle's, so the two cannot differ.
export function buildEntry({ slug, kind, bundleRef, bundle }) {
  const entry = structuredClone({ bundle: bundleRef, parent: bundle.parent, day: bundle.day, run: bundle.run, usage: bundle.usage });
  return canonical(validateEntry(entry, { slug, kind, published: false }));
}

export function published(entry, publishedAt) {
  return { ...entry, publishedAt };
}

// What a child entry's `parent` must equal.
export const entryKey = (entry) => bundleKey(entry.bundle);

const kindOrThrow = (m, kind) => {
  if (!KINDS.includes(kind)) throw new RecordShapeError(`${labelOf("manifest", m)}: unknown kind ${JSON.stringify(kind)} (one of ${KINDS.join(", ")})`);
};

export const emptyManifest = (slug) => ({ schema: MANIFEST_SCHEMA, slug, entries: {} });

export function validateManifest(m, ctx = {}) {
  const probe = shapeOf("manifest").isObject(m) ? m : {};
  const label = labelOf("manifest", { slug: ctx.slug ?? probe.slug });
  const s = shapeOf(label);
  s.object(m, "the record", ["schema", "slug", "entries"]);
  if (m.schema !== MANIFEST_SCHEMA) throw new RecordSchemaError(`${label}: schema ${JSON.stringify(m.schema)} is not readable here (this code reads schema ${MANIFEST_SCHEMA})`);
  slugField(s, m.slug, "slug");
  if (ctx.slug !== undefined && m.slug !== ctx.slug) throw s.bad("slug", `is ${m.slug}, but the file is the manifest of ${ctx.slug}`);
  s.map(m.entries, "entries", (entry, at, kind) => {
    kindField(s, kind, at);
    validateEntry(entry, { slug: m.slug, kind });
  });
  return m;
}

export function parseManifest(text, ctx = {}) {
  const label = labelOf("manifest", ctx);
  return canonical(validateManifest(parseRecord(text, label, MANIFEST_SCHEMA), ctx));
}

export function serializeManifest(m) {
  return `${stableStringify(validateManifest(m), 2)}\n`;
}

export function entryFor(m, kind) {
  kindOrThrow(m, kind);
  return m.entries[kind] ?? null;
}

// A new manifest; the argument is not changed.
export function withEntry(m, kind, entry) {
  kindOrThrow(m, kind);
  validateEntry(entry, { slug: m.slug, kind });
  return canonical({ ...m, entries: { ...m.entries, [kind]: structuredClone(entry) } });
}
