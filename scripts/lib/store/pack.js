// The pack container of design 2.1 section 7.2: bytes 0-3 "HDB1", bytes 4-7 the header
// length (u32 big-endian), a JSON header listing the items, then each item compressed
// alone, so one item is read by one byte range.
//
// Memory bound of the writer: with `spoolFile`, one item in flight plus the header's item
// list (about 250 bytes an item); without it, the compressed bytes of the pack being
// built. Pack target size: PACK_TARGET_BYTES, the design's 1.5 GiB (section 1, "Pack";
// 14.2 counts packs as ceil(bytes / 1.5 GiB)); a caller that cannot hold that much
// passes a spool file.
//
// Items are brotli quality 9 (`enc: "br"`) unless the caller marks them `enc: "raw"`:
// raw is for items that are already compressed inside (the table codec's gzip slices)
// and must be read by sub-range; see packItemStore.js.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync, constants as Z } from "node:zlib";

export const MAGIC = "HDB1";
export const PREFIX = 8;
export const PACK_TARGET_BYTES = 1.5 * 1024 ** 3;
export const BROTLI_QUALITY = 9;
// First header read: the prefix plus this many bytes, enough for about 250 items; a
// longer header costs exactly one more read.
export const HEADER_FIRST_READ = 64 * 1024;

export class PackError extends Error {
  constructor(pack, item, detail) {
    super(`pack ${pack}${item === undefined ? "" : ` item ${item}`}: ${detail}`);
    this.name = new.target.name;
    this.pack = pack;
    this.item = item;
  }
}
export class PackTruncatedError extends PackError {}
export class PackMagicError extends PackError {}
export class PackHeaderLengthError extends PackError {}
export class PackItemRangeError extends PackError {}
export class PackHashError extends PackError {}
export class PackSizeError extends PackError {}
export class PackSpoolDisposedError extends Error {
  constructor() {
    super("pack spool: read after the pack was finished and disposed");
    this.name = "PackSpoolDisposedError";
  }
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function compress(bytes) {
  return brotliCompressSync(bytes, {
    params: { [Z.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [Z.BROTLI_PARAM_SIZE_HINT]: bytes.length },
  });
}

function memorySpool() {
  const parts = [];
  let disposed = false;
  return {
    async append(buf) { parts.push(buf); },
    async read(off, len) {
      if (disposed) throw new PackSpoolDisposedError();
      const out = Buffer.alloc(len);
      let pos = 0;
      for (const p of parts) {
        const a = Math.max(off, pos);
        const b = Math.min(off + len, pos + p.length);
        if (a < b) p.copy(out, a - off, a - pos, b - pos);
        pos += p.length;
        if (pos >= off + len) break;
      }
      return out;
    },
    async *chunks() { yield* parts; },
    async dispose() { disposed = true; parts.length = 0; },
  };
}

async function fileSpool(file) {
  const fh = await fs.open(file, "w+");
  let size = 0;
  let disposed = false;
  return {
    async append(buf) { await fh.write(buf, 0, buf.length, size); size += buf.length; },
    async read(off, len) {
      if (disposed) throw new PackSpoolDisposedError();
      const out = Buffer.alloc(len);
      await fh.read(out, 0, len, off);
      return out;
    },
    async *chunks() {
      const step = 1 << 20;
      for (let off = 0; off < size; off += step) yield await this.read(off, Math.min(step, size - off));
    },
    async dispose() { disposed = true; await fh.close().catch(() => {}); await fs.rm(file, { force: true }); },
  };
}

function itemEntry(id, info, off, len, raw) {
  return {
    id, type: info.type ?? "item", slug: info.slug ?? null, path: info.path ?? null, table: info.table ?? null,
    bucket: info.bucket ?? null, day: info.day ?? null, off, len, rawSize: raw.length, rawSha256: sha256(raw),
    madeAt: info.madeAt ?? null, enc: info.enc ?? "br",
  };
}

export function createPackWriter({ meta, spoolFile } = {}) {
  const items = [];
  let body = 0;
  let spool = spoolFile ? null : memorySpool();
  const ready = async () => (spool ??= await fileSpool(spoolFile));
  return {
    get size() { return body; },
    get count() { return items.length; },
    items,
    async add(bytes, info = {}) {
      const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const stored = (info.enc ?? "br") === "raw" ? Buffer.from(raw) : compress(raw);
      await (await ready()).append(stored);
      const entry = itemEntry(items.length, info, body, stored.length, raw);
      items.push(entry);
      body += stored.length;
      return entry;
    },
    // Reads of items not yet uploaded (packItemStore serves a night's reads before flush).
    async readStored(id, off = 0, len) {
      const it = items[id];
      return (await ready()).read(it.off + off, len ?? it.len);
    },
    async finish() {
      const s = await ready();
      const header = { schema: 1, ...meta, bodySize: body, items };
      const hb = Buffer.from(JSON.stringify(header), "utf8");
      const prefix = Buffer.alloc(PREFIX);
      prefix.write(MAGIC, 0, "latin1");
      prefix.writeUInt32BE(hb.length, 4);
      const head = Buffer.concat([prefix, hb]);
      return {
        header, size: head.length + body, bodyStart: head.length,
        async *open() { yield head; yield* s.chunks(); },
        dispose: () => s.dispose(),
      };
    },
  };
}

export async function packToBuffer(out) {
  const parts = [];
  for await (const c of out.open()) parts.push(c);
  return Buffer.concat(parts);
}

async function readHeader(name, size, readRange) {
  if (size < PREFIX) throw new PackTruncatedError(name, undefined, `${size} bytes, shorter than the prefix`);
  const first = await readRange(0, Math.min(size, PREFIX + HEADER_FIRST_READ));
  if (first.subarray(0, 4).toString("latin1") !== MAGIC) throw new PackMagicError(name, undefined, "wrong magic");
  const hlen = first.readUInt32BE(4);
  if (PREFIX + hlen > size) throw new PackHeaderLengthError(name, undefined, `header length ${hlen} beyond the file of ${size} bytes`);
  let hb = first.subarray(PREFIX, PREFIX + hlen);
  if (hb.length < hlen) hb = Buffer.concat([hb, await readRange(first.length, PREFIX + hlen - first.length)]);
  let header;
  try {
    header = JSON.parse(hb.toString("utf8"));
  } catch {
    throw new PackHeaderLengthError(name, undefined, "header is not JSON");
  }
  if (header.schema !== 1 || !Array.isArray(header.items)) throw new PackHeaderLengthError(name, undefined, "header has no schema 1 item list");
  const want = PREFIX + hlen + header.bodySize;
  if (want > size) throw new PackTruncatedError(name, undefined, `${size} bytes, header says ${want}`);
  if (want < size) throw new PackSizeError(name, undefined, `${size} bytes, header says ${want}: trailing bytes`);
  return { header, bodyStart: PREFIX + hlen };
}

// `readRange(offset, length)` returns exactly those bytes of the pack.
export async function openPack({ name, size, readRange }) {
  const { header, bodyStart } = await readHeader(name, size, readRange);
  const entry = (i) => {
    const it = header.items[i];
    if (!it) throw new PackItemRangeError(name, i, "no such item");
    if (it.off < 0 || it.len < 0 || it.off + it.len > header.bodySize) throw new PackItemRangeError(name, i, `range ${it.off}+${it.len} beyond the body of ${header.bodySize} bytes`);
    return it;
  };
  return {
    name, header, bodyStart, size,
    entry,
    async readItem(i) {
      const it = entry(i);
      return verifyItem(name, i, it, await readRange(bodyStart + it.off, it.len));
    },
    // A sub-range of a raw item. Only its bounds are checked here: the whole-item hash
    // cannot be checked without reading the whole item, so the caller's own checks (the
    // codec's gzip CRC and the state check) cover the content.
    async readItemRange(i, off, len) {
      const it = entry(i);
      if (it.enc !== "raw") throw new PackItemRangeError(name, i, "sub-range read of a compressed item");
      if (off < 0 || len < 0 || off + len > it.len) throw new PackItemRangeError(name, i, `range ${off}+${len} outside the item of ${it.len} bytes`);
      return readRange(bodyStart + it.off + off, len);
    },
  };
}

export function verifyItem(name, i, it, stored) {
  if (stored.length !== it.len) throw new PackTruncatedError(name, i, `read ${stored.length} of ${it.len} bytes`);
  let raw = stored;
  if (it.enc !== "raw") {
    try {
      raw = brotliDecompressSync(stored);
    } catch (err) {
      throw new PackHashError(name, i, `does not decompress (${err.code ?? err.message})`);
    }
  }
  if (raw.length !== it.rawSize) throw new PackHashError(name, i, `size ${raw.length}, header says ${it.rawSize}`);
  if (sha256(raw) !== it.rawSha256) throw new PackHashError(name, i, "sha256 differs from the header");
  return raw;
}
