// Base and part files (design 2.1, 3.1 and 3.6). Each starts with a 4-byte magic,
// a 4-byte header length and a JSON header carrying the codec version and the
// key-spelling version. A base body is one gzip block of rows. A part body is one
// gzip block per bucket slice; the header's offset table lets one slice be read by
// range, and an absent slice costs no read. gzip's CRC makes a flipped byte fail.
import { gzipSync, gunzipSync } from "node:zlib";
import { changeRowHash, addHash, hashToHex } from "./stateCheck.js";

export const CODEC_VERSION = 1;
const MAGIC_BASE = "HDB1";
const MAGIC_PART = "HDP1";
const PREFIX = 8;
// Lower-case hex with 0x and whole bytes is stored as bytes; it decodes to the same spelling.
const HEX_KEY = /^0x(?:[0-9a-f]{2})+$/;
const BIG_7 = 0x7fn;

class ByteWriter {
  constructor() {
    this.buf = Buffer.allocUnsafe(1 << 16);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  byte(b) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  uint(n) {
    let x = n;
    while (x >= 0x80) {
      this.byte((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    this.byte(x);
  }
  big(v) {
    let z = v >= 0n ? v << 1n : ((-v) << 1n) - 1n; // zigzag
    while (z > Number.MAX_SAFE_INTEGER) {
      this.byte(Number(z & BIG_7) | 0x80);
      z >>= 7n;
    }
    this.uint(Number(z));
  }
  bytes(b) {
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  key(k) {
    const hex = HEX_KEY.test(k);
    const b = hex ? Buffer.from(k.slice(2), "hex") : Buffer.from(k, "utf8");
    this.byte(hex ? 1 : 0);
    this.uint(b.length);
    this.bytes(b);
  }
  done() {
    return this.buf.subarray(0, this.len);
  }
}

class ByteReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  byte() {
    if (this.pos >= this.buf.length) throw new Error("truncated row data");
    return this.buf[this.pos++];
  }
  big() {
    let z = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      z |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) break;
      shift += 7n;
    }
    return z & 1n ? -((z + 1n) >> 1n) : z >> 1n;
  }
  uintRaw() {
    let n = 0;
    let mul = 1;
    for (;;) {
      const b = this.byte();
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 128;
    }
  }
  key() {
    const hex = this.byte();
    const len = this.uintRaw();
    if (this.pos + len > this.buf.length) throw new Error("truncated key");
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    if (hex === 1) return `0x${b.toString("hex")}`;
    if (hex === 0) return b.toString("utf8");
    throw new Error(`bad key tag ${hex}`);
  }
  value(fields) {
    const v = new Array(fields);
    for (let i = 0; i < fields; i++) v[i] = this.big();
    return v;
  }
}

function frame(magic, header, body) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const pre = Buffer.alloc(PREFIX);
  pre.write(magic, 0, "latin1");
  pre.writeUInt32BE(h.length, 4);
  return Buffer.concat([pre, h, body]);
}

function parsePrefix(pre, magic) {
  if (pre.length < PREFIX || pre.toString("latin1", 0, 4) !== magic) throw new Error(`not a ${magic} file`);
  return pre.readUInt32BE(4);
}

function checkFields(header, value) {
  if (value.length !== header.fields) throw new Error(`value has ${value.length} fields, table has ${header.fields}`);
}

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// rows: Map key -> bigint[]. Rows are written sorted by key so equal states give equal bytes.
export function encodeBase({ header, rows }) {
  const w = new ByteWriter();
  for (const key of [...rows.keys()].sort(byKey)) {
    const v = rows.get(key);
    checkFields(header, v);
    w.key(key);
    for (const x of v) w.big(x);
  }
  return frame(MAGIC_BASE, { ...header, codec: CODEC_VERSION, count: rows.size }, gzipSync(w.done()));
}

export function decodeBase(buf) {
  const hlen = parsePrefix(buf.subarray(0, PREFIX), MAGIC_BASE);
  const header = JSON.parse(buf.toString("utf8", PREFIX, PREFIX + hlen));
  if (header.codec !== CODEC_VERSION) throw new Error(`unknown base codec version ${header.codec}`);
  const r = new ByteReader(gunzipSync(buf.subarray(PREFIX + hlen)));
  const rows = new Map();
  for (let i = 0; i < header.count; i++) {
    const key = r.key();
    if (rows.has(key)) throw new Error(`key ${key} twice in base`);
    rows.set(key, r.value(header.fields));
  }
  if (r.pos !== r.buf.length) throw new Error("trailing bytes in base");
  return { header, rows };
}

// One bucket's slice of a part, compressed alone: { body, rows, hash }. Used by encodePart and by
// the bucket-by-bucket writer (tableWrite.js writePartBuckets), which holds only this bucket's rows.
export function encodeSlice(header, sliceRows) {
  const rows = [...sliceRows].sort((a, b) => byKey(a.key, b.key));
  const w = new ByteWriter();
  let hash = 0n;
  for (const row of rows) {
    checkFields(header, row.old);
    checkFields(header, row.new);
    w.key(row.key);
    for (const x of row.old) w.big(x);
    for (const x of row.new) w.big(x);
    hash = addHash(hash, changeRowHash(row.key, row.old, row.new));
  }
  return { body: gzipSync(w.done()), rows: rows.length, hash: hashToHex(hash) };
}

// encoded: [{ bucket, body, rows, hash }] from encodeSlice, each bucket once; empty slices are skipped.
export function assemblePart({ header, encoded }) {
  const table = {};
  const bodies = [];
  let off = 0;
  for (const e of [...encoded].sort((a, b) => a.bucket - b.bucket)) {
    if (e.rows === 0) continue;
    table[e.bucket] = { off, len: e.body.length, rows: e.rows, hash: e.hash };
    bodies.push(e.body);
    off += e.body.length;
  }
  return frame(MAGIC_PART, { ...header, codec: CODEC_VERSION, slices: table }, Buffer.concat(bodies));
}

// slices: Map bucket -> [{ key, old, new }] under header.layout (the layout at the start of the part).
export function encodePart({ header, slices }) {
  const encoded = [...slices].map(([bucket, rows]) => ({ bucket, ...encodeSlice(header, rows) }));
  return assemblePart({ header, encoded });
}

export async function readPartHeader(store, ref) {
  const hlen = parsePrefix(await store.getRange(ref, 0, PREFIX), MAGIC_PART);
  const header = JSON.parse((await store.getRange(ref, PREFIX, hlen)).toString("utf8"));
  if (header.codec !== CODEC_VERSION) throw new Error(`unknown part codec version ${header.codec}`);
  return { ...header, bodyStart: PREFIX + hlen };
}

// One bucket's change rows; the slice's own row count and hash are checked here.
export async function readPartSlice(store, ref, header, bucket) {
  const s = header.slices[bucket];
  if (!s) return [];
  const r = new ByteReader(gunzipSync(await store.getRange(ref, header.bodyStart + s.off, s.len)));
  const rows = [];
  let hash = 0n;
  for (let i = 0; i < s.rows; i++) {
    const key = r.key();
    const row = { key, old: r.value(header.fields), new: r.value(header.fields) };
    hash = addHash(hash, changeRowHash(key, row.old, row.new));
    rows.push(row);
  }
  if (r.pos !== r.buf.length) throw new Error(`trailing bytes in slice ${bucket}`);
  if (hashToHex(hash) !== s.hash) throw new Error(`slice ${bucket} hash ${hashToHex(hash)} differs from its offset table ${s.hash}`);
  return rows;
}
