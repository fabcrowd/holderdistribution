/**
 * Counterparty balances per past holder snapshot, for the Solana and Hedera tier-outflow days.
 *
 * The flow day stores name each counterparty (`kind|venue|owner`). Its tier on a day is its balance in the latest
 * holder snapshot on or before that day. Reading a whole snapshot (4.8M accounts on HBAR) per stored day every
 * night only to look up a few thousand owners is what this folder avoids: one file per snapshot date
 * (`<dir>/<snapshotDate>.json`) keeps the snapshot version it was read from and, for every owner the flow store
 * needs on that date, its balance rows. A date is read again only when its file is new, unusable, of another
 * version (a same-day rerun) or lacks a needed owner; a file nothing changed is not rewritten.
 *
 * Balances, not tiers, are stored: exclusions and tier thresholds are applied by `tierOf` on every run, so a change
 * to either changes the output without reading a snapshot. Rows are kept in snapshot order (chain order, then row
 * order) so a caller can reproduce its exact rule (a sum across chains, or the last row with a tier).
 *
 * A missing, corrupt or mismatched file means "read that date again", never an error.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const TIER_COUNTERPARTY_DAYS_SCHEMA = 1;
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
// What writeAtomic leaves behind when a run dies between write and rename.
const TMP_FILE = /^\d{4}-\d{2}-\d{2}\.json\.tmp$/;

// JSON has no NaN/Infinity; String(x) round-trips them and Number() reads every form back.
const encodeOne = (x) => (Number.isFinite(x) ? x : String(x));
/** Stored form of one owner's rows: null = looked up and not a holder; a number = one row; an array = several. */
export const encodeRows = (rows) => (rows.length === 0 ? null : rows.length === 1 ? encodeOne(rows[0]) : rows.map(encodeOne));
export const decodeRows = (value) => (value === null ? [] : Array.isArray(value) ? value.map(Number) : [Number(value)]);

// Only what encodeOne writes: a finite number, or one of the three strings String() gives a non-finite one. Anything
// else (a hand edit, "abc") makes the date's file unusable, so it is re-read instead of becoming a NaN balance.
const NON_FINITE = new Set(["NaN", "Infinity", "-Infinity"]);
const isRowValue = (v) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && NON_FINITE.has(v));
const isStoredRows = (v) => v === null || isRowValue(v) || (Array.isArray(v) && v.length > 1 && v.every(isRowValue));
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Latest snapshot date on or before `date` (snapDates ascending), or null. Same walk as the generator's tierAt. */
export const latestOnOrBefore = (snapDates, date) => {
  let best = null;
  for (const d of snapDates) { if (d <= date) best = d; else break; }
  return best;
};

/** snapshot date -> Set of owners the flow store looks up against it. */
export const neededBySnapshotDate = (store, snapDates) => {
  const needed = new Map();
  for (const chain of Object.values(store?.chains ?? {})) {
    for (const [date, day] of Object.entries(chain?.days ?? {})) {
      const snapDate = latestOnOrBefore(snapDates, date);
      if (!snapDate) continue;
      const owners = needed.get(snapDate) ?? new Set();
      for (const key of Object.keys(day?.counterparties ?? {})) {
        const owner = key.split("|")[2];
        if (owner) owners.add(owner);
      }
      needed.set(snapDate, owners);
    }
  }
  return needed;
};

const dateFile = (dir, date) => path.join(dir, `${date}.json`);

/**
 * One date's file as `{ entry: { version, balances: Map owner -> stored rows } }`, or `{ problem }`.
 * Balances are a Map so an owner named like an Object.prototype key (`__proto__`, `constructor`) is an ordinary key.
 */
export const parseDateFile = (text, basis) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: "corrupt JSON" };
  }
  if (!isPlainObject(raw) || raw.schema !== TIER_COUNTERPARTY_DAYS_SCHEMA) return { problem: "unknown schema" };
  if (!isDeepStrictEqual(raw.basis, basis)) return { problem: "another snapshot file, chains or rows rule" };
  if (typeof raw.version !== "string" || !isPlainObject(raw.balances)) return { problem: "malformed" };
  const balances = new Map(Object.entries(raw.balances));
  if (![...balances.values()].every(isStoredRows)) return { problem: "malformed balances" };
  return { entry: { version: raw.version, balances } };
};

const readDateFile = async (dir, date, basis) => {
  let text;
  try {
    text = await fs.readFile(dateFile(dir, date), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { missing: true };
    return { problem: `unreadable (${e.code ?? e.message})` };
  }
  return parseDateFile(text, basis);
};

/** Compact JSON; `Object.fromEntries` defines `__proto__` as an own key, so JSON.stringify writes it like any other. */
export const serializeDateFile = (basis, version, balances) => {
  const sorted = [...balances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify({ schema: TIER_COUNTERPARTY_DAYS_SCHEMA, basis, version, balances: Object.fromEntries(sorted) })}\n`;
};

// tmp + rename per file (as scan-hedera-flows.js writes its store): a crash never leaves half a file.
const writeAtomic = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
};

const listNames = async (dir) => {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};
const listDateFiles = async (dir) => (await listNames(dir)).map((name) => DATE_FILE.exec(name)?.[1]).filter(Boolean);

/** Removes tmp files a crashed write left behind (the workflows stage the whole folder); returns how many. */
const removeLeftoverTmp = async (dir) => {
  const leftovers = (await listNames(dir)).filter((name) => TMP_FILE.test(name));
  for (const name of leftovers) await fs.rm(path.join(dir, name), { force: true });
  return leftovers.length;
};

/**
 * Bring `dir` up to date for `store` and return `tierAt(date)`: a Map owner -> tier for the latest snapshot on or
 * before `date` (an empty Map before the first one), holding every owner the store looks up there.
 *
 * - `basis`: what the stored rows depend on (snapshot file, chains, rows rule); a file with another basis is re-read.
 * - `versions`: Map snapshot date -> current version (stateStore.versionsByDate).
 * - `readRows(snapDate, version)`: iterable of { address, balance } in snapshot order (address trimmed, balance a
 *   Number), read from that snapshot.
 * - `tierOf(owner, rows)`: the tier label, or a falsy value for none. Exclusions belong here.
 *
 * The folder itself is never removed, so a workflow that stages it still sees deleted date files.
 */
export const resolveCounterpartyTiers = async ({ dir, basis, store, snapDates, versions, readRows, tierOf, log = console.log }) => {
  const needed = neededBySnapshotDate(store, snapDates);
  const leftovers = await removeLeftoverTmp(dir);
  if (leftovers > 0) log(`Tier counterparty days: removed ${leftovers} leftover tmp file(s) from an interrupted write.`);
  const entries = new Map();
  let reads = 0;
  let written = 0;
  for (const snapDate of [...needed.keys()].sort()) {
    const owners = needed.get(snapDate);
    const version = versions.get(snapDate);
    const file = await readDateFile(dir, snapDate, basis);
    const prev = file.entry;
    const reuse = prev !== undefined && prev.version === version;
    const missing = reuse ? [...owners].filter((o) => !prev.balances.has(o)) : [...owners];
    const balances = new Map();
    if (reuse) for (const o of owners) if (prev.balances.has(o)) balances.set(o, prev.balances.get(o));
    if (missing.length > 0) {
      const reason = file.missing ? "new day" : file.problem ? `file not usable (${file.problem})` : !reuse ? "version changed" : `${missing.length} new counterparties`;
      log(`Tier counterparty days: read snapshot ${snapDate} (${String(version).slice(0, 8)}): ${reason}.`);
      reads += 1;
      const targets = new Map(missing.map((o) => [o, []]));
      for (const { address, balance } of readRows(snapDate, version)) targets.get(address)?.push(balance);
      for (const [owner, list] of targets) balances.set(owner, encodeRows(list));
    }
    // Written when read, pruned (an owner the store no longer names) or new; an unchanged file keeps its bytes.
    const pruned = reuse ? prev.balances.size - (balances.size - missing.length) : 0;
    if (missing.length > 0 || pruned > 0 || !reuse) {
      if (pruned > 0 && missing.length === 0) log(`Tier counterparty days: ${snapDate}: dropped ${pruned} counterparties the flow store no longer names.`);
      await writeAtomic(dateFile(dir, snapDate), serializeDateFile(basis, version, balances));
      written += 1;
    }
    entries.set(snapDate, balances);
  }
  let removed = 0;
  if (needed.size === 0) {
    // A store with no days (empty, freshly rebuilt or restored) says nothing about which dates are still needed;
    // clearing the folder on it would make the next run re-read every snapshot. Owners are pruned per needed date,
    // so with none, nothing is pruned either.
    log("Tier counterparty days: the flow store names no snapshot dates; keeping every date file as it is.");
  } else {
    for (const date of await listDateFiles(dir)) {
      if (needed.has(date)) continue;
      await fs.rm(dateFile(dir, date), { force: true });
      removed += 1;
    }
  }
  log(`Tier counterparty days: snapshots read: ${reads} of ${needed.size}; files written: ${written}, removed: ${removed}.`);

  const maps = new Map();
  const mapFor = (snapDate) => {
    if (!maps.has(snapDate)) {
      const tiers = new Map();
      for (const [owner, value] of entries.get(snapDate) ?? []) {
        const t = tierOf(owner, decodeRows(value));
        if (t) tiers.set(owner, t);
      }
      maps.set(snapDate, tiers);
    }
    return maps.get(snapDate);
  };
  return {
    reads,
    written,
    removed,
    snapshotDates: needed.size,
    tierAt: (date) => {
      const snapDate = latestOnOrBefore(snapDates, date);
      return snapDate ? mapFor(snapDate) : new Map();
    },
  };
};
