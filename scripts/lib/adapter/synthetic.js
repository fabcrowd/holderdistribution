// A generated ledger behind the adapter contract, for proving size and for testing readers and conformance.
// Memory is bounded at any number of accounts: see syntheticMath.js. Day d is the cursor { height: d, id }.
// Day 0 is the genesis state, at the end of `epochDay`; day d ends with the UTC date epochDay + d.
//
// Changes come in slot order, not account order, and the accounts of an interval are a union of per-day
// progressions mod H that cannot be walked in account order without holding them, so this ledger does not
// declare `sortedChanges`: a reader pays memory in proportion to the interval's changed accounts.
//
// Page tokens are strings, not bare numbers: a token carries the running row count (and the running sum for
// full lists) so the last page can state `total` and `sum` without a second pass over the range.

import { makeCursor, isCursor, RESUME_REJECTED } from "./contract.js";
import { ACCOUNT_PATTERN, createModel, hash, parseAccount } from "./syntheticMath.js";

const MS_PER_DAY = 86_400_000;
const STAKE_KIND = "stake";

const fault = (message, extra) => Object.assign(new Error(message), extra);
const parseDay = (dayUtc) => {
  const ms = Date.parse(`${dayUtc}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) || Number.isNaN(ms)) throw new TypeError(`dayUtc must be "YYYY-MM-DD", got ${String(dayUtc)}`);
  return Math.floor(ms / MS_PER_DAY);
};

function parseToken(token, fields) {
  const parts = String(token).split(".");
  if (parts.length !== fields || parts.some((p) => !/^\d+$/.test(p))) throw fault(`bad page token ${String(token)}`, { code: "bad-token" });
  return parts.map((p) => BigInt(p));
}

/** One page of the accounts that changed between two days, for one kind of balance. */
function changesPage(def, from, to, token, pageSlots) {
  const { model } = def;
  const C = model.changesPerDay;
  const slots = (to - from) * C;
  const [start, emittedBefore] = token === null ? [0, 0] : parseToken(token, 2).map(Number);
  const end = Math.min(start + pageSlots, slots);
  const rows = [];
  const transfers = [];
  for (let s = start; s < end; s++) {
    const day = from + 1 + Math.floor(s / C);
    const k = s % C;
    const i = def.indexAt(day, k);
    if (def.transfersAt && k % 2 === 0 && model.hasPartner(k)) transfers.push(...def.transfersAt(day, k));
    // An account that also changed on an earlier day of the interval is reported once, at its first day.
    let earlier = false;
    for (let d = from + 1; d < day && !earlier; d++) earlier = def.slotAt(d, i) >= 0;
    if (earlier) continue;
    const balance = def.valueAt(i, to);
    if (balance !== def.valueAt(i, from)) rows.push({ account: model.accountName(i), balance });
  }
  const emitted = emittedBefore + rows.length;
  const last = end >= slots;
  return { rows, transfers, count: rows.length, next: last ? null : `${end}.${emitted}`, ...(last ? { total: emitted } : {}) };
}

/** One page of positive balances in an index range at one day, for one kind of balance. */
function fullPage(def, height, at, range, token, pageRows) {
  const { model } = def;
  const [start, countBefore, sumBefore] = token === null ? [range.from, 0n, 0n] : parseToken(token, 3);
  const first = Number(start);
  const end = Math.min(first + pageRows, range.to);
  const rows = [];
  let sum = 0n;
  for (let i = first; i < end; i++) {
    const balance = def.valueAt(i, height);
    if (balance <= 0n) continue;
    rows.push({ account: model.accountName(i), balance });
    sum += balance;
  }
  const count = countBefore + BigInt(rows.length);
  const last = end >= range.to;
  return { rows, count: rows.length, at, next: last ? null : `${end}.${count}.${sumBefore + sum}`, ...(last ? { total: Number(count), sum: sumBefore + sum } : {}) };
}

// Faults hit a page call by its position in the adapter's call sequence, so a run is repeatable. A retry of
// the same page is a new call and usually passes.
function createFaults(seed, faults) {
  const { refuseEvery = 0, shortPageEvery = 0, repeatRowEvery = 0, shuffle = false, rejectResumeEvery = 0 } = faults;
  const hits = (every, call) => every > 0 && call % every === 0;
  return {
    before(call, token) {
      if (hits(refuseEvery, call)) throw fault(`synthetic refusal on call ${call}`, { retryable: true });
      if (token !== null && hits(rejectResumeEvery, call)) throw fault(`synthetic rejection of page token ${token}`, { code: RESUME_REJECTED });
    },
    after(call, reply) {
      let rows = reply.rows;
      if (hits(shortPageEvery, call) && rows.length > 0) rows = rows.slice(1);
      // The repeat replaces the last row, so the page keeps its length and only a repeat check can see it.
      if (hits(repeatRowEvery, call) && rows.length > 1) rows = [...rows.slice(0, -1), rows[0]];
      if (shuffle) rows = [...rows].sort((p, q) => hash(seed, call, parseAccount(p.account)) - hash(seed, call, parseAccount(q.account)));
      return { ...reply, rows };
    },
  };
}

function checkOptions(o) {
  const positive = (name) => {
    if (!Number.isInteger(o[name]) || o[name] < 1) throw new RangeError(`${name} must be a positive integer, got ${String(o[name])}`);
  };
  ["seed", "accounts", "changesPerDay", "days", "maxPageRows"].forEach(positive);
  if (o.maxPageRows < 2) throw new RangeError("maxPageRows must be at least 2 (a transfer pair travels in one page)");
  if (!(o.stakeShare >= 0 && o.stakeShare <= 1)) throw new RangeError(`stakeShare must be in [0, 1], got ${o.stakeShare}`);
  parseDay(o.epochDay);
}

/**
 * @param {{ seed?: number, accounts?: number, changesPerDay?: number, days?: number, stakeShare?: number,
 *   pastReadable?: boolean, listsTransfers?: boolean, maxPageRows?: number, epochDay?: string,
 *   liveHeight?: number, faults?: { refuseEvery?: number, shortPageEvery?: number, repeatRowEvery?: number,
 *   shuffle?: boolean, rejectResumeEvery?: number } }} [options]
 * @returns {import("./contract.js").LedgerAdapter & { advanceLive(): number }}
 */
export function createSyntheticAdapter(options = {}) {
  const o = { seed: 1, accounts: 1000, changesPerDay: 100, days: 5, stakeShare: 0.1, pastReadable: true, listsTransfers: true, maxPageRows: 1000, epochDay: "2026-01-01", faults: {}, ...options };
  checkOptions(o);
  const model = createModel(o);
  const epoch = parseDay(o.epochDay);
  const pageRows = o.maxPageRows - (o.maxPageRows % 2);
  const faults = createFaults(o.seed, o.faults);
  let calls = 0;
  let live = Math.min(o.liveHeight ?? o.days, o.days);

  const cursorAt = (height) => makeCursor(height, model.dayId(height));
  const checkCursor = (cursor, name) => {
    if (!isCursor(cursor) || cursor.height > o.days) throw fault(`${name} is not a cursor of this ledger: ${JSON.stringify(cursor)}`, { code: "bad-cursor" });
    if (cursor.id !== model.dayId(cursor.height)) throw fault(`${name} id does not match height ${cursor.height}: the ledger was reorganized`, { code: "cursor-mismatch" });
    return cursor.height;
  };
  const transfersAt = (day, k) => {
    const out = model.pairOutcome(day, k / 2);
    if (out.amount === 0n) return [];
    return [{ from: model.accountName(out.from), to: model.accountName(out.to), amount: out.amount, height: day }];
  };
  const kinds = {
    balance: { model, indexAt: model.balanceIndex, slotAt: model.balanceSlot, valueAt: model.balanceAt, transfersAt: o.listsTransfers ? transfersAt : null },
    [STAKE_KIND]: { model, indexAt: model.stakeIndex, slotAt: model.stakeSlot, valueAt: model.stakeAt, transfersAt: null },
  };
  const kindOf = (kind) => {
    if (kind !== STAKE_KIND) throw new TypeError(`unknown position kind ${String(kind)}`);
    return kinds[kind];
  };
  const served = (token, work) => {
    const call = ++calls;
    faults.before(call, token);
    return faults.after(call, work());
  };
  const changes = (def, from, to, token) => {
    const a = checkCursor(from, "from");
    const b = checkCursor(to, "to");
    if (a > b) throw new RangeError(`from (${a}) is after to (${b})`);
    return served(token, () => changesPage(def, a, b, token, pageRows));
  };
  const full = (def, at, range, token) => {
    if (at !== "live" && !o.pastReadable) throw fault("this ledger can only be listed live", { code: "past-unreadable" });
    const height = at === "live" ? live : checkCursor(at, "at");
    return served(token, () => fullPage(def, height, cursorAt(height), range, token, pageRows));
  };

  return {
    family: "synthetic",
    capabilities: { pastReadable: o.pastReadable, changeSource: "asset-records", listsTransfers: o.listsTransfers, balanceMovesWithoutRecord: false, maxPageRows: pageRows, sortedPages: !o.faults.shuffle },
    positionKinds: model.hasStakers ? [STAKE_KIND] : [],
    normalizeAccount: (text) => String(text).trim().toLowerCase(),
    isAccount: (text) => typeof text === "string" && ACCOUNT_PATTERN.test(text),
    explorerUrl: (kind, id) => `https://explorer.invalid/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    discover: () => ({ decimals: model.decimals, supply: model.supply, start: cursorAt(0) }),
    settledEnd: (_asset, dayUtc) => cursorAt(Math.min(Math.max(parseDay(dayUtc) - epoch, 0), o.days)),
    changes: (_asset, from, to, page = null) => changes(kinds.balance, from, to, page),
    ranges: (_asset, n) => {
      if (!Number.isInteger(n) || n < 1) throw new RangeError(`ranges: n must be an integer of at least 1, got ${String(n)}`);
      const parts = Math.min(n, model.accounts);
      return Array.from({ length: parts }, (_, r) => ({ from: Math.floor((r * model.accounts) / parts), to: Math.floor(((r + 1) * model.accounts) / parts) }));
    },
    fullList: (_asset, at, range, page = null) => full(kinds.balance, at, range, page),
    positionChanges: (_asset, kind, from, to, page = null) => changes(kindOf(kind), from, to, page),
    // The contract gives positionsFull no `at`: it always reflects the live state, and the reply says which cursor.
    positionsFull: (_asset, kind, range, page = null) => full(kindOf(kind), "live", range, page),
    // Moves what "live" reflects forward one day, to test the live mode of a ledger that cannot be read in the past.
    advanceLive: () => (live = Math.min(live + 1, o.days)),
  };
}
