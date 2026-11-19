// Names of design 2.1 section 7.1. Every build has a parse that round-trips, and
// `isStoreName` is the one predicate a sweep may rely on: it touches only names that
// match these patterns exactly (no case folding, no path separators, no suffixes).
export class NameError extends Error {
  constructor(message) {
    super(message);
    this.name = "NameError";
  }
}

export const PACK_CLASSES = ["keep", "hist", "live", "events"];
export const KINDS = ["holders", "ledger", "walletFlows"];
export const SERIES = ["keep", "hist", "live", "events", "site"];

// At most 15 digits, so every number is a safe integer and a name rebuilt from its
// parsed fields is the same name (a 20-digit run id would not round-trip).
const NUM = "(0|[1-9]\\d{0,14})";
const POS = "([1-9]\\d{0,14})";
const DAY = "(\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01]))";
const CLS = `(${PACK_CLASSES.join("|")})`;

const PACK = new RegExp(`^p\\.${CLS}\\.(${KINDS.join("|")})\\.${DAY}\\.r${NUM}a${NUM}\\.l${NUM}f${NUM}\\.hdb$`);
const GIT_PACK = new RegExp(`^p\\.${CLS}\\.holders\\.${DAY}\\.git([0-9a-f]{12})\\.hdb$`);
const LIST = /^list\.([0-9a-f]{64})\.br$/;
const SITE = new RegExp(`^site\\.${DAY}\\.r${NUM}a${NUM}p${NUM}\\.json$`);
const TAG = new RegExp(`^data-(${SERIES.join("|")})-${POS}$`);

// A real calendar day: 2026-02-31 matches the pattern but is not one.
function realDay(s) {
  const [y, mo, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function must(re, name, what) {
  const m = typeof name === "string" ? name.match(re) : null;
  const day = m && name.match(/\d{4}-\d{2}-\d{2}/);
  if (!m || (day && !realDay(day[0]))) throw new NameError(`not a ${what} name: ${JSON.stringify(name)}`);
  return m;
}

// Builders format, then parse their own output, so a bad field fails the same way a bad name does.
function checked(name, parse) {
  parse(name);
  return name;
}

export function packName({ cls, kind, day, run, attempt, lane, flush }) {
  return checked(`p.${cls}.${kind}.${day}.r${run}a${attempt}.l${lane}f${flush}.hdb`, parsePackName);
}
export function parsePackName(name) {
  const m = must(PACK, name, "pack");
  return { cls: m[1], kind: m[2], day: m[3], run: Number(m[4]), attempt: Number(m[5]), lane: Number(m[6]), flush: Number(m[7]) };
}

export function gitPackName({ cls, day, sha }) {
  return checked(`p.${cls}.holders.${day}.git${sha}.hdb`, parseGitPackName);
}
export function parseGitPackName(name) {
  const m = must(GIT_PACK, name, "git pack");
  return { cls: m[1], day: m[2], sha: m[3] };
}

export function listName(sha) {
  return checked(`list.${sha}.br`, parseListName);
}
export function parseListName(name) {
  return { sha: must(LIST, name, "list version")[1] };
}

export function siteRootName({ day, run, attempt, try: t }) {
  return checked(`site.${day}.r${run}a${attempt}p${t}.json`, parseSiteRootName);
}
export function parseSiteRootName(name) {
  const m = must(SITE, name, "site root");
  return { day: m[1], run: Number(m[2]), attempt: Number(m[3]), try: Number(m[4]) };
}

export function releaseTag(series, seq) {
  return checked(`data-${series}-${seq}`, parseReleaseTag);
}
export function parseReleaseTag(tag) {
  const m = must(TAG, tag, "release tag");
  return { series: m[1], seq: Number(m[2]) };
}

// { type, series, ...fields } for any name the store owns, else null.
export function parseStoreName(name) {
  try {
    return parseStoreNameOrThrow(name);
  } catch (err) {
    if (err instanceof NameError) return null; // a pattern match with an impossible day
    throw err;
  }
}

function parseStoreNameOrThrow(name) {
  if (typeof name !== "string") return null;
  if (PACK.test(name)) { const f = parsePackName(name); return { type: "pack", series: f.cls, ...f }; }
  if (GIT_PACK.test(name)) { const f = parseGitPackName(name); return { type: "gitPack", series: f.cls, ...f }; }
  if (LIST.test(name)) return { type: "list", series: "keep", ...parseListName(name) };
  if (SITE.test(name)) return { type: "site", series: "site", ...parseSiteRootName(name) };
  return null;
}

export function isStoreName(name) {
  return parseStoreName(name) !== null;
}

export function seriesOfName(name) {
  const p = parseStoreName(name);
  if (!p) throw new NameError(`not a store name: ${JSON.stringify(name)}`);
  return p.series;
}
