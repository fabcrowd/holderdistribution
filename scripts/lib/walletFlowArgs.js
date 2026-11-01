// Argument parsing and output guards for the wallet-flows backfill flags:
//   --as-of <YYYY-MM-DD | ISO timestamp with Z or offset>   anchor the windows to that moment
//   --out <path>                                            write the report there (repo-relative)
// Pure functions only, so the rules are testable without RPC. `--out` must never resolve under
// public/ (gated forensics data), and `--as-of` must write to its own file, never the live report.

import path from "node:path";

const AS_OF_FLAG = "--as-of";
const OUT_FLAG = "--out";
const PUBLIC_DIR = "public";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Value of `--flag <value>` or `--flag=<value>`; undefined when absent, throws when valueless. */
function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    return value;
  }
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

/** True when the calendar date in `YYYY-MM-DD` is real (rejects 2026-02-31, which Date.parse would roll over). */
function isRealCalendarDate(raw) {
  const [y, m, d] = raw.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parses `--as-of`. A bare date means UTC midnight; a time must carry `Z` or an offset so the
 * result never depends on the machine's time zone. Future dates are rejected (no data yet).
 */
export function parseAsOf(raw, { nowMs = Date.now() } = {}) {
  const shapeOk = typeof raw === "string" && (DATE_ONLY.test(raw) || DATE_TIME.test(raw));
  const ms = shapeOk ? Date.parse(raw) : Number.NaN;
  if (!shapeOk || Number.isNaN(ms) || !isRealCalendarDate(raw)) {
    throw new Error(`${AS_OF_FLAG} must be YYYY-MM-DD or an ISO timestamp with Z or an offset, got "${raw}"`);
  }
  if (ms > nowMs) throw new Error(`${AS_OF_FLAG} must not be in the future, got "${raw}"`);
  return { ts: Math.floor(ms / 1000), iso: new Date(ms).toISOString() };
}

/** True when `abs` is `root/public` or inside it. Case-insensitive on Windows via path.relative. */
export function isUnderPublic(abs, root) {
  const rel = path.relative(path.resolve(root, PUBLIC_DIR), abs);
  if (rel === "") return true;
  return rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel);
}

/**
 * Validates the backfill flags. Returns `{ asOf, out }`, both null when neither flag is given
 * (the default run is unchanged). `liveOut` is the default live report path, which `--as-of` may not overwrite.
 */
export function parseWalletFlowArgs({ argv = [], root, liveOut, nowMs = Date.now() } = {}) {
  const asOfRaw = flagValue(argv, AS_OF_FLAG);
  const outRaw = flagValue(argv, OUT_FLAG);
  const asOf = asOfRaw === undefined ? null : parseAsOf(asOfRaw, { nowMs });
  if (outRaw === undefined) {
    if (asOf) throw new Error(`${AS_OF_FLAG} requires ${OUT_FLAG}; a backfill must not overwrite the live report`);
    return { asOf, out: null };
  }
  const out = path.resolve(root, outRaw);
  if (isUnderPublic(out, root)) {
    throw new Error(`${OUT_FLAG} must not resolve under ${PUBLIC_DIR}/ (gated forensics data stays under data/)`);
  }
  if (asOf && liveOut && path.resolve(liveOut) === out) {
    throw new Error(`${AS_OF_FLAG} needs an ${OUT_FLAG} other than the live report (${path.relative(root, out)})`);
  }
  return { asOf, out };
}

/** Window anchor in unix seconds: the as-of moment, or now. */
export function anchorSeconds(asOf, nowMs = Date.now()) {
  return asOf ? asOf.ts : Math.floor(nowMs / 1000);
}
