// What a caller says about an item it puts into a pack (design 2.1 section 7.2: the header
// item's `type`, `slug`, `path`, `table`, `bucket`, `day`, `madeAt`). The store decides the
// rest (id, off, len, hashes, encoding), so none of those is accepted from a caller.
//
// Closed list of types, one per thing a lane stores (7.3): `bundle` the coin's record; `blob`
// a stored file; `base` and `part` the table code's bases and change files; `index` the
// state index version; `slice` a yearly-copy slice; `history` an account history file;
// `list` a list version; `day` the day store; `item` an item with no more to say, which is
// what a plain put(bytes) is. A type outside the list is refused rather than stored, because
// a reader (the sweep, adoption) acts on the type.
//
// The coin: a lane's store requires one on every put (PackCoinRequiredError), because a pack
// whose items name no coin has no coin list and the sweep then keeps it forever. A store
// made without `requireCoin` (the table code's tests) accepts a put with none.
import { SLUG } from "./itemRef.js";
import { isDay } from "./shape.js";

export const ITEM_TYPES = ["item", "bundle", "blob", "base", "part", "index", "slice", "history", "list", "day"];
const FIELDS = ["type", "slug", "path", "table", "bucket", "day", "madeAt"];

export class PackItemInfoError extends Error {
  constructor(message) {
    super(`pack item store: ${message}`);
    this.name = "PackItemInfoError";
  }
}

export class PackCoinRequiredError extends Error {
  constructor(detail) {
    super(`pack item store: every item of a lane pack carries a coin (info.slug), ${detail}`);
    this.name = "PackCoinRequiredError";
  }
}

export class PackItemTooLargeError extends Error {
  constructor(size, limit) {
    super(`pack item store: an item of ${size} bytes is over the limit of ${limit} bytes for one item (a pack must stay under GitHub's 2 GiB asset limit)`);
    this.name = "PackItemTooLargeError";
  }
}

const bad = (problem) => new PackItemInfoError(`item information ${problem}`);
const isText = (v) => typeof v === "string" && v !== "";

export function checkSlug(slug) {
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new PackItemInfoError(`coin slug must match ${SLUG}, got ${JSON.stringify(slug)}`);
  return slug;
}

// A new object with every header field set (null when not given); the argument is not changed.
export function validateItemInfo(info = {}) {
  if (info === null || typeof info !== "object" || Array.isArray(info)) throw bad(`must be an object, got ${JSON.stringify(info)}`);
  for (const k of Object.keys(info)) {
    if (!FIELDS.includes(k)) throw bad(`has the unknown field "${k}" (a caller gives ${FIELDS.join(", ")}; the store decides the rest)`);
  }
  const out = Object.fromEntries(FIELDS.map((k) => [k, info[k] ?? null]));
  out.type ??= "item";
  if (!ITEM_TYPES.includes(out.type)) throw bad(`has type ${JSON.stringify(out.type)}, which is not one of ${ITEM_TYPES.join(", ")}`);
  if (out.slug !== null) checkSlug(out.slug);
  for (const k of ["path", "table"]) if (out[k] !== null && !isText(out[k])) throw bad(`${k} must be a non-empty string, got ${JSON.stringify(out[k])}`);
  if (out.bucket !== null && !(Number.isSafeInteger(out.bucket) && out.bucket >= 0)) throw bad(`bucket must be a whole number from 0, got ${JSON.stringify(out.bucket)}`);
  if (out.day !== null && !isDay(out.day)) throw bad(`day must be a calendar day (YYYY-MM-DD), got ${JSON.stringify(out.day)}`);
  if (out.madeAt !== null && !(isText(out.madeAt) && !Number.isNaN(Date.parse(out.madeAt)))) throw bad(`madeAt must be a date-time string, got ${JSON.stringify(out.madeAt)}`);
  return out;
}

export function itemInfoFor(info, { requireCoin }) {
  const out = validateItemInfo(info);
  if (requireCoin && out.slug === null) throw new PackCoinRequiredError(`and this put has none (type ${out.type})`);
  return out;
}

// The information of a put made through the view of one coin: the coin is the view's.
export function infoForCoin(slug, info = {}) {
  const out = validateItemInfo(info);
  if (out.slug !== null && out.slug !== slug) throw new PackItemInfoError(`the view of coin ${slug} was given an item of coin ${out.slug}`);
  return { ...out, slug };
}
