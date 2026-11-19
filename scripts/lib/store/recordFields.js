// Field checks the record modules share: slug, kind, run, parent, and a pack table row.
import { KINDS } from "./packNames.js";
import { parseLoc, StoreNameError } from "./blobStore.js";
import { SLUG, packInfo, parseBundleKey } from "./itemRef.js";

const RUN_KEYS = ["id", "attempt", "workflow"];
const ROW_KEYS = ["name", "loc", "size", "sha256", "headerSha256", "items"];

export function slugField(s, v, at) {
  s.match(v, at, SLUG, "a coin slug");
}

export function kindField(s, v, at) {
  if (!KINDS.includes(v)) throw s.bad(at, `must be one of ${KINDS.join(", ")}, got ${JSON.stringify(v)}`);
}

export function runField(s, v, at) {
  s.object(v, at, RUN_KEYS);
  s.posint(v.id, `${at}.id`);
  s.posint(v.attempt, `${at}.attempt`);
  s.string(v.workflow, `${at}.workflow`);
}

// The full key of the coin's previous bundle ("<release>/<pack>#<id>@<sha256>"), or null.
export function parentField(s, v, at) {
  if (v !== null && !parseBundleKey(v)) {
    throw s.bad(at, `must be null or a bundle key "<release>/<pack name>#<item id>@<sha256>", got ${JSON.stringify(v)}`);
  }
}

// The row's location must be "<release tag>/<its own name>", in the series of its class.
export function locField(s, row, at) {
  let loc;
  try {
    loc = parseLoc(row.loc);
  } catch (err) {
    if (err instanceof StoreNameError) throw s.bad(`${at}.loc`, `is not a location: ${err.message}`);
    throw err;
  }
  if (loc.name !== row.name) throw s.bad(`${at}.loc`, `is ${row.loc}, which is not the location of ${row.name}`);
}

// { name, loc, size, sha256, headerSha256, items }, as packItemStore.close() returns it.
export function packRowField(s, row, at) {
  s.object(row, at, ROW_KEYS);
  if (!packInfo(row.name)) throw s.bad(`${at}.name`, `is not a pack name: ${JSON.stringify(row.name)}`);
  locField(s, row, at);
  s.posint(row.size, `${at}.size`);
  s.sha256(row.sha256, `${at}.sha256`);
  s.sha256(row.headerSha256, `${at}.headerSha256`);
  s.uint(row.items, `${at}.items`);
}
