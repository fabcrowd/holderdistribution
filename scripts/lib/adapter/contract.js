// The ledger adapter contract as code. Every ledger sits behind these members; shared code asks the declared
// capabilities and never asks "which ledger is this". See tasks/scale-100/design/0-architecture.md, part 1.
//
// Rules the types cannot say:
//  - Disjoint ranges are the adapter's duty: `ranges(asset, n)` returns `n` ranges that cover every account
//    once. The reader does not remember accounts across ranges; the `ranges-cover` conformance check and the
//    caller's count and sum against its record catch an overlap or a gap. `n` is an integer of at least 1; an
//    adapter rejects anything else with a named error.
//  - An adapter cannot know the old balance (the caller's record holds it), so a `changes` row whose balance
//    equals the old balance is allowed only when the account was touched in the interval (it sent and received
//    the same amount, for example). On an adapter that lists transfers, conformance fails a row for an account
//    that no transfer of the interval touches, and every adapter's result reports how many such rows it saw.
//
// Conventions: every balance is a bigint. An account is the canonical string the ledger's explorer shows as
// the holder. Any member may be synchronous or return a promise; callers always `await`.

/**
 * @typedef {{ height: number, id: string }} Cursor
 *   A point on the ledger: a block number or sequence and its hash or id (the id lets a reorganization be
 *   detected).
 *
 * @typedef {{ from: *, to: * }} AccountRange
 *   An opaque account range. Only the adapter looks inside; callers pass it back unchanged.
 *
 * @typedef {{ account: string, balance: bigint }} Row
 *   The account's balance (or locked amount) at the cursor the page reflects. In `changes`, zero means the
 *   account left the ledger.
 *
 * @typedef {{ from: string, to: string, amount: bigint, height: number }} Transfer
 *
 * @typedef {object} Capabilities
 * @property {boolean} pastReadable   `fullList(at)` works for a past cursor; false means only "live".
 * @property {"asset-records"|"ledger-state"|"none"} changeSource  how a day's changes are found.
 * @property {boolean} listsTransfers  `changes` returns transfers.
 * @property {boolean} balanceMovesWithoutRecord  balances move with no record the adapter can read (then
 *   transfers cannot explain a change).
 * @property {number} maxPageRows  largest page the adapter returns.
 * @property {boolean} [sortedPages]  pages of one `fullList` range come in strictly ascending account order
 *   (plain `<` on the strings), across pages. Lets a reader check repeats with no memory. Applies to
 *   `fullList` and `positionsFull` only.
 * @property {boolean} [sortedChanges]  pages of one `changes` (or `positionChanges`) call come in strictly
 *   ascending account order across pages, so a reader checks repeats with no memory. Without it the reader
 *   remembers every account of the call: memory in proportion to the number of changed accounts in the
 *   interval (C per day, summed over the interval). Past `maxTrackedAccounts` the reader throws an
 *   AdapterReadError with code TOO_MANY_UNSORTED; the caller then reads the interval in two halves (changes
 *   compose: A to M, then M to B) or the adapter sorts its changes.
 *
 * @typedef {object} PageCheck
 * Added to every page reply so a short, long or repeated page can be told from a correct one.
 * @property {number} count   rows this page should hold.
 * @property {number} [total] on the last page (`next === null`): rows across the whole call sequence.
 * @property {bigint} [sum]   on the last page of a `fullList` or `positionsFull` sequence: sum of balances.
 * @property {string|null} next  opaque page token, or null on the last page.
 *
 * @typedef {PageCheck & { rows: Row[], transfers: Transfer[] }} ChangesPage
 * @typedef {PageCheck & { rows: Row[], at: Cursor }} FullListPage
 *
 * @typedef {object} LedgerAdapter
 * @property {string} family
 * @property {Capabilities} capabilities
 * @property {string[]} positionKinds  kinds of locked balance the adapter serves (may be empty).
 * @property {(text: string) => string} normalizeAccount
 * @property {(text: string) => boolean} isAccount
 * @property {(kind: string, id: string) => string} explorerUrl
 * @property {(asset: *) => { decimals: number, supply: bigint, start: Cursor }} discover
 * @property {(asset: *, dayUtc: string) => Cursor} settledEnd   dayUtc is "YYYY-MM-DD"
 * @property {(asset: *, from: Cursor, to: Cursor, page?: string|null) => ChangesPage} changes
 * @property {(asset: *, n: number) => AccountRange[]} ranges
 * @property {(asset: *, at: Cursor|"live", range: AccountRange, page?: string|null) => FullListPage} fullList
 * @property {(asset: *, kind: string, from: Cursor, to: Cursor, page?: string|null) => ChangesPage} positionChanges
 * @property {(asset: *, kind: string, range: AccountRange, page?: string|null) => FullListPage} positionsFull
 */

/** Error code an adapter sets when it will not accept a page token any more: the caller restarts that range. */
export const RESUME_REJECTED = "resume-rejected";

export const CHANGE_SOURCES = Object.freeze(["asset-records", "ledger-state", "none"]);

export const REQUIRED_FUNCTIONS = Object.freeze([
  "normalizeAccount",
  "isAccount",
  "explorerUrl",
  "discover",
  "settledEnd",
  "changes",
  "ranges",
  "fullList",
]);

// Needed only when positionKinds is not empty: an adapter without locked balances has none to serve.
export const POSITION_FUNCTIONS = Object.freeze(["positionChanges", "positionsFull"]);

const BOOLEAN_CAPABILITIES = ["pastReadable", "listsTransfers", "balanceMovesWithoutRecord"];

const describe = (value) => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value === "object" ? "an object" : `${typeof value} ${String(value)}`;
};

const fail = (member, want, got) => {
  throw new TypeError(`adapter.${member} must be ${want}, got ${describe(got)}`);
};

function validateCapabilities(caps) {
  if (caps === null || typeof caps !== "object") fail("capabilities", "an object", caps);
  for (const name of BOOLEAN_CAPABILITIES) {
    if (typeof caps[name] !== "boolean") fail(`capabilities.${name}`, "a boolean", caps[name]);
  }
  if (!CHANGE_SOURCES.includes(caps.changeSource)) {
    fail("capabilities.changeSource", `one of ${CHANGE_SOURCES.join(", ")}`, caps.changeSource);
  }
  if (!Number.isInteger(caps.maxPageRows) || caps.maxPageRows < 1) {
    fail("capabilities.maxPageRows", "a positive integer", caps.maxPageRows);
  }
  if (caps.sortedPages !== undefined && typeof caps.sortedPages !== "boolean") {
    fail("capabilities.sortedPages", "a boolean when present", caps.sortedPages);
  }
  if (caps.sortedChanges !== undefined && typeof caps.sortedChanges !== "boolean") {
    fail("capabilities.sortedChanges", "a boolean when present", caps.sortedChanges);
  }
}

/**
 * Throws a TypeError naming the first missing or mistyped member; returns the adapter when it is complete.
 * @param {*} adapter
 * @returns {LedgerAdapter}
 */
export function validateAdapter(adapter) {
  if (adapter === null || typeof adapter !== "object") throw new TypeError(`adapter must be an object, got ${describe(adapter)}`);
  if (typeof adapter.family !== "string" || adapter.family === "") fail("family", "a non-empty string", adapter.family);
  validateCapabilities(adapter.capabilities);
  const kinds = adapter.positionKinds;
  if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== "string" || k === "")) {
    fail("positionKinds", "an array of non-empty strings", kinds);
  }
  const functions = kinds.length > 0 ? [...REQUIRED_FUNCTIONS, ...POSITION_FUNCTIONS] : REQUIRED_FUNCTIONS;
  for (const name of functions) {
    if (typeof adapter[name] !== "function") fail(name, "a function", adapter[name]);
  }
  return adapter;
}

/** @returns {Cursor} */
export function makeCursor(height, id) {
  if (!Number.isSafeInteger(height) || height < 0) throw new TypeError(`cursor.height must be a non-negative integer, got ${describe(height)}`);
  if (typeof id !== "string" || id === "") throw new TypeError(`cursor.id must be a non-empty string, got ${describe(id)}`);
  return Object.freeze({ height, id });
}

export const isCursor = (value) =>
  value !== null && typeof value === "object" && Number.isSafeInteger(value.height) && value.height >= 0 && typeof value.id === "string" && value.id !== "";

export function assertCursor(value, name = "cursor") {
  if (!isCursor(value)) throw new TypeError(`${name} must be { height: non-negative integer, id: non-empty string }, got ${describe(value)}`);
  return value;
}

/** Order by height; the id only tells two cursors at one height apart (a reorganization). */
export const compareCursors = (a, b) => a.height - b.height;

export const sameCursor = (a, b) => a.height === b.height && a.id === b.id;
