// The first real table format of the store (design 2.1 section 1 "Codec", section 3; the spec interface is
// in laneTables.js): the ever-held list, `holders-ever-checkpoint.json`.
//
// Shape (every coin kind; written by generate-holders-history.js as one JSON.stringify, no newline):
//   {"generatedAt":"<day>","cumulativeHolders":<n>,"addresses":["a","b",...]}
// `addresses` is the last field and is sorted by Array.prototype.sort (UTF-16 code units, so "0.0.10" comes
// before "0.0.2"), no duplicates. A row is [address, [1n]]: the list is a set, so the one field is the
// constant 1 ("held at some time"); an address that is not in the list has no row. The header is every
// other field, kept as the exact text that precedes the list ({ prefix }): the bundle writes a header with its
// keys sorted (stable.js), so a parsed header could not give back the field order of the file. Rows are bucketed by hash, the file is sorted: the order is a function of the
// keys, so write rebuilds the file byte for byte from the rows and the header alone (laneRestore's sha256
// check). Evidence: tableFormats.test.js (real excerpts of three coin kinds) and the whole committed
// files of every registered coin (see the slice report).
//
// What this format refuses, so that a wrong guess fails the coin loudly instead of at the restore check:
// pretty-printing, a trailing newline, a list that is not the last field, escaped or empty keys, keys out of order or
// repeated, mixed-case hex (normKey spells hex in lower case, design 1: the case could not be restored),
// text after the list. readHeader checks that the text before the list is an object ending in the list;
// readRows checks every row and the end of the file.
//
// Not formats here, with the reason (slice report A5a): the account snapshot `tel-holders.json` lists its
// wallets by balance with ties by address (holderOrder.js: account number for 0.0.<n>, else code-unit order;
// older files keep the scan's insertion order until the next nightly rewrites them), the raw-balance checkpoint
// `holders-checkpoint.json` writes its keys in code-unit order (same rewrite caveat), and the sharded
// snapshot (`tel-holders.d/wallets-NNN.tsv`) is one table in many files.
//
// Memory and cost by size (H = rows): readRows holds one read chunk (chunkBytes, 1 MiB) and one row; the file
// is read once. write holds one bucket's keys (at most about 2R, design 3.1) while it writes that bucket as a
// sorted run (keyRuns.js), then merges the runs into the file with one line per run in memory; disk: the keys
// once more in the runs (about 14 bytes a key for 0.0.n, 44 for hex, 45 for base58); time: every key is sorted
// in its bucket, written and read once, and written once more into the file (two merge passes above 64 buckets).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { mergeKeys, mergeRuns, writeRun, writeText } from "./keyRuns.js";

export const EVER_SET_FIELDS = 1;
const LIST_START = '"addresses":[';
const PREFIX_LIMIT = 1 << 16;
const CHUNK_BYTES = 1 << 20;
const DEFAULT_FAN_IN = 64;
// A key is a JSON string without escapes, control characters or U+FFFD (what invalid UTF-8 decodes to).
const TOKEN = /"([^"\\\u0000-\u001f�]*)"(,|\]\})/y;
const KEY_LIMIT = 4096;
const MIXED_HEX = /^0x[0-9a-fA-F]*$/;
const UNWRITABLE = /["\\\u0000-\u001f�]/;
const ONE = [1n];

export class TableShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

const shape = (file, what) => new TableShapeError(`${file}: not the ever-held list this format rebuilds byte for byte: ${what}`);

// The text that starts the file, up to and including the `[` of the list, checked to be an object whose last
// field is the list. Returns { prefix, length }.
function parsePrefix(file, text) {
  const at = text.indexOf(LIST_START);
  if (at < 0) throw shape(file, `no "addresses" list within the first ${PREFIX_LIMIT} characters`);
  const prefix = text.slice(0, at + LIST_START.length);
  let obj;
  try {
    obj = JSON.parse(`${prefix}]}`);
  } catch {
    throw shape(file, "the text before the list is not JSON");
  }
  const isObject = obj !== null && typeof obj === "object" && !Array.isArray(obj);
  if (!isObject || Object.keys(obj).at(-1) !== "addresses") throw shape(file, '"addresses" is not the last field of an object');
  return { prefix, length: prefix.length };
}

function checkKey(file, key, prev) {
  if (key === "") throw shape(file, "an empty key");
  if (key.length > KEY_LIMIT) throw shape(file, `a key of ${key.length} characters (the limit is ${KEY_LIMIT})`);
  if (MIXED_HEX.test(key) && key !== key.toLowerCase()) throw shape(file, `key ${key} is hex with upper-case digits`);
  if (prev !== null && !(prev < key)) throw shape(file, `key ${key} does not come after ${prev} (keys must be unique and sorted)`);
}

export function makeEverSetFormat({ fanIn = DEFAULT_FAN_IN, chunkBytes = CHUNK_BYTES } = {}) {
  async function readHeader(file) {
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(PREFIX_LIMIT);
      const { bytesRead } = await fh.read(buf, 0, PREFIX_LIMIT, 0);
      const { prefix } = parsePrefix(file, buf.toString("utf8", 0, bytesRead));
      return { prefix };
    } finally {
      await fh.close();
    }
  }

  async function* readRows(file) {
    let buf = "";
    let pos = 0;
    let started = false;
    let first = true;
    let finished = false;
    let prev = null;
    for await (const chunk of fs.createReadStream(file, { encoding: "utf8", highWaterMark: chunkBytes })) {
      buf = buf.slice(pos) + chunk;
      pos = 0;
      if (!started) {
        const at = buf.indexOf(LIST_START);
        if (at < 0) {
          if (buf.length > PREFIX_LIMIT) throw shape(file, `no "addresses" list within the first ${PREFIX_LIMIT} characters`);
          continue;
        }
        pos = parsePrefix(file, buf.slice(0, at + LIST_START.length)).length;
        started = true;
      }
      while (!finished) {
        if (first) {
          if (buf.length - pos < 2) break;
          if (buf.startsWith("]}", pos)) {
            pos += 2;
            finished = true;
            break;
          }
          first = false;
        }
        TOKEN.lastIndex = pos;
        const m = TOKEN.exec(buf);
        if (!m) {
          if (buf.length - pos > KEY_LIMIT + 8) throw shape(file, `a row that is not a plain quoted key, near ${JSON.stringify(buf.slice(pos, pos + 40))}`);
          break;
        }
        checkKey(file, m[1], prev);
        prev = m[1];
        pos = TOKEN.lastIndex;
        if (m[2] === "]}") finished = true;
        yield [m[1], ONE];
      }
      if (finished && pos < buf.length) throw shape(file, "text after the end of the list");
    }
    if (!started) throw shape(file, `no "addresses" list`);
    if (!finished || pos < buf.length) throw shape(file, `the list does not end with "]}" at the end of the file (near ${JSON.stringify(buf.slice(pos, pos + 40))})`);
  }

  function checkRow(file, key, value) {
    if (typeof key !== "string" || key === "" || UNWRITABLE.test(key) || key.length > KEY_LIMIT || !key.isWellFormed()) throw shape(file, `key ${JSON.stringify(key)} cannot be written as a plain JSON string`);
    if (MIXED_HEX.test(key) && key !== key.toLowerCase()) throw shape(file, `key ${key} is hex with upper-case digits`);
    if (value.length !== EVER_SET_FIELDS || value[0] !== 1n) throw shape(file, `the row of ${key} is not [1n]`);
  }

  async function write(file, header, buckets) {
    const bad = Object.keys(header).join() !== "prefix" || typeof header.prefix !== "string" || parsePrefix(file, header.prefix).length !== header.prefix.length;
    if (bad) throw shape(file, "the header is not { prefix } with the text that precedes the list");
    const tmpFile = `${file}.write-${process.pid}`;
    const dir = await fsp.mkdtemp(`${file}.runs-`);
    try {
      let runs = [];
      let lastBucket = -1;
      for await (const { bucket, rows } of buckets) {
        if (!(bucket > lastBucket)) throw shape(file, `bucket ${bucket} does not come after bucket ${lastBucket}`);
        lastBucket = bucket;
        if (rows.size === 0) continue;
        const keys = [];
        for (const [key, value] of rows) {
          checkRow(file, key, value);
          keys.push(key);
        }
        const run = path.join(dir, `r${runs.length}`);
        await writeRun(run, keys);
        runs.push(run);
      }
      const onDuplicate = (key) => {
        throw shape(file, `key ${key} is in two buckets`);
      };
      runs = await mergeRuns(runs, { dir, fanIn, onDuplicate });
      await writeText(tmpFile, (async function* text() {
        yield header.prefix;
        let first = true;
        for await (const key of mergeKeys(runs, onDuplicate)) {
          yield `${first ? "" : ","}${JSON.stringify(key)}`;
          first = false;
        }
        yield "]}";
      })());
      await fsp.rename(tmpFile, file);
    } finally {
      await fsp.rm(tmpFile, { force: true });
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  return { readHeader, readRows, write };
}

export const everSetFormat = makeEverSetFormat();
