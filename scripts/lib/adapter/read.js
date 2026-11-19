// The only way shared code reads an adapter. A read ends with every row delivered exactly once, or throws:
// a short, long, repeated or mismatched page is retried up to a bound and then fails with the range and page
// in the message. Rows go to a callback page by page; the reader keeps only what the repeat check needs.
//
// Memory bound, per sequence (one `fullList` range, or one `changes` call):
//  - pages declared sorted (`sortedPages` for `fullList` and `positionsFull`, `sortedChanges` for `changes` and
//    `positionChanges`): two strings, however long the sequence;
//  - otherwise: one Map entry per account of that sequence, dropped when the sequence ends. A `fullList`
//    sequence is one range, so the caller bounds it by choosing the number of ranges. An unsorted `changes`
//    sequence costs memory in proportion to the number of changed accounts in the interval (C per day, summed
//    over the interval): a ledger that cannot sort its changes pays that, and a long interval pays it in full;
//  - the Map never grows past `maxTrackedAccounts` (default 5,000,000): a larger sequence throws a named error
//    instead of crashing the heap. The error has `code` TOO_MANY_UNSORTED and the fields `tracked` and `bound`,
//    so a caller can act without parsing the message. For `changes` the remedies are, in order: read the
//    interval in two halves (changes compose, A to M then M to B, and the store takes several parts per day),
//    or sorted changes. For `fullList`: more ranges, or sorted pages.
// Every sequence also ends: it throws when more than `maxEmptyPages` (default 100) pages in a row hold no rows
// and still name a next page, when a page's next token repeats one of the last few tokens, or when it passes
// `maxPages` (default 1,000,000) pages.
// Not checked here: an account served by two ranges. Disjoint ranges are the adapter's duty; the
// `ranges-cover` conformance check and the caller's count and sum against its record catch an overlap.
// A rejected page token restarts the sequence. Rows already delivered are not delivered again: the repeat
// check remembers them (the Map, or the highest delivered account when sorted), so a restart costs requests,
// not duplicates.

import { RESUME_REJECTED } from "./contract.js";

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_EMPTY_PAGES = 100;
const DEFAULT_MAX_PAGES = 1_000_000;
const DEFAULT_MAX_TRACKED_ACCOUNTS = 5_000_000;
const RECENT_TOKENS = 4; // a token cycle up to this long is caught at once; a longer one ends at maxPages

/** `code` of the error an unsorted sequence throws past `maxTrackedAccounts`; it also carries `tracked` and `bound`. */
export const TOO_MANY_UNSORTED = "TOO_MANY_UNSORTED";

export class AdapterReadError extends Error {
  // `options` may carry machine-readable fields (`code`, `tracked`, `bound`) next to `cause`.
  constructor(message, { code, tracked, bound, ...options } = {}) {
    super(message, options);
    this.name = "AdapterReadError";
    if (code !== undefined) Object.assign(this, { code, tracked, bound });
  }
}

// A whole-sequence mismatch (total or sum): the sequence is read again from its first page.
class SequenceMismatch extends Error {}

function createSeen(sorted) {
  let attempt = 0;
  const delivered = new Map(); // account -> attempt that delivered it (unsorted pages)
  let last = null; // last account of the current attempt (sorted pages)
  let highest = null; // highest account ever delivered (sorted pages)

  // `skip` holds accounts an earlier attempt already delivered; null when the whole page is new.
  const checkUnsorted = (rows) => {
    const local = new Set();
    let skip = null;
    for (const { account } of rows) {
      if (local.has(account) || delivered.get(account) === attempt) return { problem: `account ${account} appears twice in one sequence` };
      local.add(account);
      if (delivered.has(account)) (skip ??= new Set()).add(account);
    }
    return { skip };
  };
  const checkSorted = (rows) => {
    let previous = last;
    let skip = null;
    for (const { account } of rows) {
      if (previous !== null && account <= previous) return { problem: `account ${account} is not after ${previous} in a sorted sequence (repeat or out of order)` };
      previous = account;
      if (highest !== null && account <= highest) (skip ??= new Set()).add(account);
    }
    return { skip };
  };

  return {
    check: (rows) => (sorted ? checkSorted(rows) : checkUnsorted(rows)),
    commit(rows) {
      if (rows.length === 0) return;
      if (sorted) {
        last = rows[rows.length - 1].account;
        if (highest === null || last > highest) highest = last;
      } else {
        for (const { account } of rows) delivered.set(account, attempt);
      }
    },
    restart() {
      attempt += 1;
      last = null;
    },
    tracked: () => delivered.size,
  };
}

const describeToken = (token) => (token === null ? "first page" : `page token ${token}`);

function pageProblem(reply, spec) {
  if (reply === null || typeof reply !== "object" || !Array.isArray(reply.rows)) return "reply has no rows array";
  if (!Number.isInteger(reply.count)) return "reply has no integer count";
  if (reply.rows.length !== reply.count) return `page holds ${reply.rows.length} rows, expected ${reply.count}`;
  if (reply.next !== null && typeof reply.next !== "string") return "reply.next must be a string or null";
  for (const row of reply.rows) {
    if (typeof row?.account !== "string" || typeof row.balance !== "bigint") return `malformed row ${JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
  }
  if (reply.next === null) {
    if (!Number.isInteger(reply.total)) return "last page has no integer total";
    if (spec.wantSum && typeof reply.sum !== "bigint") return "last page has no bigint sum";
  }
  return spec.checkAt?.(reply) ?? null;
}

async function fetchValidPage(spec, token) {
  let problem = "";
  for (let attempt = 0; attempt <= spec.maxRetries; attempt++) {
    spec.stats.requests += 1;
    let reply;
    try {
      reply = await spec.fetch(token);
    } catch (error) {
      if (error?.code === RESUME_REJECTED) throw error;
      // A thrown null or string has no `message`: say what was thrown instead of failing on it.
      const message = error instanceof Error ? error.message : `threw ${String(error)}`;
      if (error?.retryable !== true) throw new AdapterReadError(`${spec.label}, ${describeToken(token)}: ${message}`, { cause: error });
      problem = message;
      continue;
    }
    problem = pageProblem(reply, spec) ?? "";
    if (problem === "") {
      const checked = spec.seen.check(reply.rows);
      if (checked.problem === undefined) return { reply, skip: checked.skip };
      problem = checked.problem;
    }
  }
  throw new AdapterReadError(`${spec.label}, ${describeToken(token)}: gave up after ${spec.maxRetries} retries: ${problem}`);
}

// Throws when the sequence cannot end: too many pages, too many empty pages in a row, a token seen lately, or
// more accounts to track than allowed.
function checkProgress(spec, progress, token, reply) {
  const { label, limits } = spec;
  const where = `${label}, ${describeToken(token)}`;
  if (reply.rows.length > 0) progress.emptyRun = 0;
  else if (reply.next !== null && (progress.emptyRun += 1) > limits.maxEmptyPages) {
    throw new AdapterReadError(`${where}: more than ${limits.maxEmptyPages} empty pages in a row that still name a next page (maxEmptyPages)`);
  }
  if (reply.next !== null && progress.pages >= limits.maxPages) throw new AdapterReadError(`${where}: more than ${limits.maxPages} pages in one sequence (maxPages)`);
  progress.recent.push(token);
  if (progress.recent.length > RECENT_TOKENS) progress.recent.shift();
  if (reply.next !== null && progress.recent.includes(reply.next)) {
    throw new AdapterReadError(`${where}: the next page token ${reply.next} repeats a recent page token, so the sequence would never end`);
  }
  const tracked = spec.seen.tracked();
  if (tracked > limits.maxTrackedAccounts) {
    const remedies = spec.isChanges ? "read the interval in two halves, or sorted changes (capabilities.sortedChanges)" : "use more ranges, or sorted pages (capabilities.sortedPages)";
    throw new AdapterReadError(
      `${where}: more than ${limits.maxTrackedAccounts} accounts to track for the repeat check (maxTrackedAccounts); the range is too large for an unsorted sequence: ${remedies}`,
      { code: TOO_MANY_UNSORTED, tracked, bound: limits.maxTrackedAccounts },
    );
  }
}

async function runAttempt(spec) {
  let token = null;
  let pageIndex = 0;
  let count = 0;
  let sum = 0n;
  const progress = { emptyRun: 0, pages: 0, recent: [] };
  for (;;) {
    const { reply, skip } = await fetchValidPage(spec, token);
    const rows = skip === null ? reply.rows : reply.rows.filter((row) => !skip.has(row.account));
    spec.seen.commit(reply.rows);
    checkProgress(spec, progress, token, reply);
    progress.pages += 1;
    count += reply.rows.length;
    if (spec.wantSum) for (const row of reply.rows) sum += row.balance;
    await spec.deliver({ reply, rows, pageIndex });
    spec.stats.rows += rows.length;
    spec.stats.pages += 1;
    if (reply.next === null) {
      if (count !== reply.total) throw new SequenceMismatch(`sequence holds ${count} rows, the last page says ${reply.total}`);
      if (spec.wantSum && sum !== reply.sum) throw new SequenceMismatch(`sequence sums to ${sum}, the last page says ${reply.sum}`);
      return;
    }
    token = reply.next;
    pageIndex += 1;
  }
}

async function readSequence(spec) {
  for (let restarts = 0; ; restarts++) {
    try {
      return await runAttempt(spec);
    } catch (error) {
      const restartable = error instanceof SequenceMismatch || error?.code === RESUME_REJECTED;
      if (!restartable) throw error;
      if (restarts >= spec.maxRetries) throw new AdapterReadError(`${spec.label}: gave up after ${spec.maxRetries} restarts: ${error.message}`, { cause: error });
      spec.stats.restarts += 1;
      spec.seen.restart();
    }
  }
}

const newStats = () => ({ rows: 0, pages: 0, requests: 0, restarts: 0 });
const retriesOf = (options) => options.maxRetries ?? DEFAULT_MAX_RETRIES;
const limitsOf = (options) => ({
  maxEmptyPages: options.maxEmptyPages ?? DEFAULT_MAX_EMPTY_PAGES,
  maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
  maxTrackedAccounts: options.maxTrackedAccounts ?? DEFAULT_MAX_TRACKED_ACCOUNTS,
});

async function readChangesOf(fetch, label, options, sorted) {
  const stats = newStats();
  let transfersThrough = 0; // transfers of page n are delivered once; a replayed sequence repeats page n
  const spec = {
    label,
    fetch,
    stats,
    maxRetries: retriesOf(options),
    limits: limitsOf(options),
    isChanges: true,
    wantSum: false,
    seen: createSeen(sorted),
    async deliver({ reply, rows, pageIndex }) {
      if (rows.length > 0) await options.onRows?.(rows);
      if (pageIndex >= transfersThrough && reply.transfers?.length > 0) await options.onTransfers?.(reply.transfers);
      transfersThrough = Math.max(transfersThrough, pageIndex + 1);
    },
  };
  await readSequence(spec);
  return stats;
}

/**
 * Every account whose balance differs between `from` and `to`, delivered once. Resolves to
 * `{ rows, pages, requests, restarts }`.
 * @param {import("./contract.js").LedgerAdapter} adapter
 * @param {{ onRows?: (rows: import("./contract.js").Row[]) => *, onTransfers?: (t: import("./contract.js").Transfer[]) => *, maxRetries?: number,
 *   maxEmptyPages?: number, maxPages?: number, maxTrackedAccounts?: number }} [options]
 */
export const readChanges = (adapter, asset, from, to, options = {}) =>
  readChangesOf((token) => adapter.changes(asset, from, to, token), `changes ${from.height}..${to.height}`, options, adapter.capabilities?.sortedChanges === true);

/** Same as `readChanges`, for locked balances of one kind. */
export const readPositionChanges = (adapter, asset, kind, from, to, options = {}) =>
  readChangesOf((token) => adapter.positionChanges(asset, kind, from, to, token), `positionChanges ${kind} ${from.height}..${to.height}`, options, adapter.capabilities?.sortedChanges === true);

const sameAt = (want, got) => got !== null && typeof got === "object" && want.height === got.height && want.id === got.id;

function rangeCount(label, n) {
  if (!Number.isInteger(n) || n < 1) throw new AdapterReadError(`${label}: n must be an integer of at least 1, got ${String(n)}`);
  return n;
}

async function readRanges({ label, fetchRange, at, adapter, asset, options }) {
  if (at !== null && at !== "live" && adapter.capabilities?.pastReadable === false) {
    throw new AdapterReadError(`${label}: this ledger cannot be read at a past cursor; read "live" instead`);
  }
  const ranges = options.ranges ?? (await adapter.ranges(asset, rangeCount(label, options.n ?? 1)));
  if (!Array.isArray(ranges) || ranges.length === 0) throw new AdapterReadError(`${label}: no ranges to read`);
  const sorted = adapter.capabilities?.sortedPages === true;
  const total = newStats();
  let sum = 0n;
  for (const [rangeIndex, range] of ranges.entries()) {
    const stats = newStats();
    await readSequence({
      label: `${label} range ${rangeIndex}/${ranges.length}`,
      fetch: (token) => fetchRange(range, token),
      stats,
      maxRetries: retriesOf(options),
      limits: limitsOf(options),
      wantSum: true,
      seen: createSeen(sorted),
      checkAt: at && at !== "live" ? (reply) => (sameAt(at, reply.at) ? null : `page reflects ${JSON.stringify(reply.at)}, not the requested cursor`) : (reply) => (reply.at ? null : "reply has no `at`"),
      async deliver({ reply, rows }) {
        for (const row of rows) sum += row.balance;
        if (rows.length > 0) await options.onRows?.(rows, { range, rangeIndex, at: reply.at });
      },
    });
    for (const key of Object.keys(total)) total[key] += stats[key];
  }
  return { ...total, ranges: ranges.length, sum };
}

/**
 * Every account with a positive balance at `at` (a cursor, or "live"), range by range, each row delivered once.
 * `onRows(rows, { range, rangeIndex, at })` gets each page, where `at` is the cursor the page reflects.
 * Resolves to `{ rows, pages, requests, restarts, ranges, sum }`.
 * @param {{ ranges?: import("./contract.js").AccountRange[], n?: number, onRows?: Function, maxRetries?: number,
 *   maxEmptyPages?: number, maxPages?: number, maxTrackedAccounts?: number }} [options]
 */
export const readFullList = (adapter, asset, at, options = {}) =>
  readRanges({ label: "fullList", fetchRange: (range, token) => adapter.fullList(asset, at, range, token), at, adapter, asset, options });

/** Same as `readFullList`, for locked balances of one kind; the adapter always answers with its live state. */
export const readPositionsFull = (adapter, asset, kind, options = {}) =>
  readRanges({ label: `positionsFull ${kind}`, fetchRange: (range, token) => adapter.positionsFull(asset, kind, range, token), at: null, adapter, asset, options });
