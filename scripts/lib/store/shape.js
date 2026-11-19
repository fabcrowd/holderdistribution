// Validation of parsed JSON at the boundary of the record modules. Every check throws a
// RecordShapeError whose message starts with the record's label (which names the coin and
// kind) and the path of the field that failed. No coercion: a wrong type is an error.
//
// Cost: linear in the size of the record; a record is KB (a bundle about 120 bytes per
// table bucket, design 4.3), so nothing here grows with D.
import { RecordSyntaxError, RecordSchemaError, RecordShapeError } from "./errors.js";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];
const SHA256 =/^[0-9a-f]{64}$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isDay(v) {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function labelOf(what, { slug, kind } = {}) {
  const who = [typeof slug === "string" ? slug : null, typeof kind === "string" ? kind : null].filter(Boolean).join("/");
  return who ? `${what} ${who}` : what;
}

// Text or bytes to an object whose `schema` is `schemaNow`.
export function parseRecord(input, label, schemaNow) {
  let value;
  try {
    value = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch (err) {
    throw new RecordSyntaxError(`${label}: not valid JSON (${err.message})`, { cause: err });
  }
  if (!isObject(value)) throw new RecordShapeError(`${label}: the record must be a JSON object`);
  if (value.schema !== schemaNow) {
    throw new RecordSchemaError(`${label}: schema ${JSON.stringify(value.schema)} is not readable here (this code reads schema ${schemaNow})`);
  }
  return value;
}

export function shapeOf(label) {
  const bad = (at, problem) => new RecordShapeError(`${label}: ${at} ${problem}`);
  return {
    bad,
    object(v, at, required, optional = []) {
      if (!isObject(v)) throw bad(at, "must be an object");
      for (const k of required) if (!Object.hasOwn(v, k)) throw bad(at, `is missing "${k}"`);
      for (const k of Object.keys(v)) {
        if (!required.includes(k) && !optional.includes(k)) throw bad(at, `has the unknown field "${k}"`);
      }
      return v;
    },
    map(v, at, each) {
      if (!isObject(v)) throw bad(at, "must be an object");
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.includes(k)) throw bad(at, `has the key "${k}", which is refused in every open-keyed object (it would change an object's prototype or hide a value)`);
        each(x, `${at}.${k}`, k);
      }
    },
    array(v, at) {
      if (!Array.isArray(v)) throw bad(at, "must be an array");
      return v;
    },
    string(v, at) {
      if (typeof v !== "string" || v === "") throw bad(at, "must be a non-empty string");
    },
    match(v, at, re, what) {
      if (typeof v !== "string" || !re.test(v)) throw bad(at, `must be ${what}, got ${JSON.stringify(v)}`);
    },
    uint(v, at) {
      if (!Number.isSafeInteger(v) || v < 0) throw bad(at, `must be a whole number from 0, got ${JSON.stringify(v)}`);
    },
    posint(v, at) {
      if (!Number.isSafeInteger(v) || v < 1) throw bad(at, `must be a whole number from 1, got ${JSON.stringify(v)}`);
    },
    sha256(v, at) {
      if (typeof v !== "string" || !SHA256.test(v)) throw bad(at, "must be a lower-case sha256 hex string");
    },
    day(v, at) {
      if (!isDay(v)) throw bad(at, `must be a calendar day (YYYY-MM-DD), got ${JSON.stringify(v)}`);
    },
    isObject,
  };
}
