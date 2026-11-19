// Item references and bundle identities, as the merged store code spells them: a
// reference is "<pack name>#<item id>" (packItemStore.js). A bundle is identified by its
// full key "<release>/<pack name>#<item id>@<sha256>": identity is the location (blobStore.js),
// and many coins share one pack, so neither a pack name nor "<pack name>#<slug>" names one
// bundle. A pack name alone never selects a pack: a reference resolves only through a pack
// table row.
import { NameError, parseReleaseTag, parseStoreName } from "./packNames.js";

export const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const ITEM_ID = /^(0|[1-9]\d{0,14})$/;

const split = (s) => {
  const at = typeof s === "string" ? s.lastIndexOf("#") : -1;
  return at < 1 ? null : { head: s.slice(0, at), tail: s.slice(at + 1) };
};

// { cls, kind } of a pack name (a git-history pack is a holders pack), else null.
export function packInfo(name) {
  const p = parseStoreName(name);
  if (!p || (p.type !== "pack" && p.type !== "gitPack")) return null;
  return { cls: p.series, kind: p.type === "gitPack" ? "holders" : p.kind };
}

export function parseItemRef(ref) {
  const s = split(ref);
  if (!s || !ITEM_ID.test(s.tail) || !packInfo(s.head)) return null;
  return { pack: s.head, id: Number(s.tail) };
}

export const packNameOf = (ref) => parseItemRef(ref)?.pack ?? null;

const HEX64 = /^[0-9a-f]{64}$/;

export const bundleKeyOf = ({ release, ref, sha256 }) => `${release}/${ref}@${sha256}`;

// { release, ref, sha256 } of a bundle key, or null; the release must be a live release.
export function parseBundleKey(text) {
  const at = typeof text === "string" ? text.lastIndexOf("@") : -1;
  const slash = at < 0 ? -1 : text.indexOf("/");
  if (at < 0 || slash < 1) return null;
  const release = text.slice(0, slash);
  const ref = text.slice(slash + 1, at);
  const sha256 = text.slice(at + 1);
  if (!HEX64.test(sha256) || !parseItemRef(ref) || packInfo(packNameOf(ref)).cls !== "live") return null;
  try {
    if (parseReleaseTag(release).series !== "live") return null;
  } catch (err) {
    if (err instanceof NameError) return null;
    throw err;
  }
  return { release, ref, sha256 };
}

// Every item reference found anywhere inside a JSON value (a table descriptor's shape is
// the table code's business; its references are found by form).
export function refsIn(value, found = new Set()) {
  if (typeof value === "string") {
    if (parseItemRef(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) refsIn(v, found);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) refsIn(v, found);
  }
  return found;
}
