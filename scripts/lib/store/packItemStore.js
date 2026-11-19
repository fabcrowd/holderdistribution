// The item-store seam of itemStore.js on packs: one night's puts are buffered into a
// pack, uploaded through the blob store when the pack reaches its target size and at
// close(), and read back by byte range.
//
// Contract with the caller (the crash rule): refs are durable only after close()
// resolves. close() returns the pack table, { packs: [{ name, loc, size, sha256, headerSha256, items }] },
// and the caller saves its index together with that table (the manifest's map from pack
// to release, design section 1 "Reference"). A flush that fails throws from the put or
// close() that triggered it, and every ref of that pack then throws PackLostError; a
// store object dropped before close() uploaded nothing for its open pack, so no saved
// index can name those refs.
//
// Ref: "<pack name>#<item id>", a plain string that survives JSON. A read resolves the
// pack through the table (this store's uploads plus the saved `packs` passed in) and
// reads by location: no listing. A pack in neither throws PackUnknownError on get and
// getRange; has() answers false, as the seam does for any unknown ref. There is no
// lookup by name: another run's pack can carry the same name (A3 builds tables itself).
// A row is checked when its pack is first opened: the stored size (stat, 0 core
// requests) against `size`, and the sha256 of the header bytes against `headerSha256`
// when the row has one; a mismatch throws PackRowMismatchError.
// Headers are cached by pack name: at most `headerCache` entries and
// HEADER_CACHE_BYTES of header JSON.
//
// Items are stored raw (enc "raw"): the table codec already gzips each base and each
// bucket slice of a part, and a part's slices must be read by sub-range. Whole-item
// reads (get) check rawSize and rawSha256; small items read by range are fetched whole
// once and checked the same way; a sub-range of a large item is bounds-checked and
// relies on the codec's gzip CRC and the state check (pack.js, readItemRange).
//
// Range reads: the first read into an item fetches its first HEAD_WINDOW bytes (the
// whole item when it is smaller), so a part's prefix, header and nearby slices cost one
// range read; later reads outside the window cost one each. The table code awaits one
// read at a time, so there are no concurrent reads to merge beyond what the window does.
import { createHash } from "node:crypto";
import path from "node:path";
import { createPackWriter, openPack, verifyItem, PACK_TARGET_BYTES, PackSpoolDisposedError } from "./pack.js";
import { StoreNotFoundError } from "./blobStore.js";

export const HEAD_WINDOW = 64 * 1024;
const WINDOW_CACHE_BYTES = 8 * 1024 * 1024;
// About 250 bytes of header per item: 16 MiB holds the headers of about 65,000 items.
export const HEADER_CACHE_BYTES = 16 * 1024 * 1024;

export class PackLostError extends Error {
  constructor(ref, cause) {
    super(`pack item store: ${ref} was in a pack whose upload failed (${cause})`);
    this.name = "PackLostError";
  }
}

export class PackUnknownError extends Error {
  constructor(name) {
    super(`pack item store: pack ${name} is in no pack table of this store`);
    this.name = "PackUnknownError";
  }
}

export class PackRowMismatchError extends Error {
  constructor(loc, field, want, got) {
    super(`pack item store: ${loc} does not match its pack table row: ${field} is ${got}, the row says ${want}`);
    this.name = "PackRowMismatchError";
  }
}

function parseRef(ref) {
  const at = typeof ref === "string" ? ref.lastIndexOf("#") : -1;
  const id = at < 0 ? NaN : Number(ref.slice(at + 1));
  if (!Number.isInteger(id) || id < 0) throw new Error(`pack item store: bad ref ${JSON.stringify(ref)}`);
  return { name: ref.slice(0, at), id };
}

// Hashes the bytes, and the header bytes (the first bodyStart), as the upload reads
// them; a retry reopens the source and starts over.
function hashingSource(out) {
  const state = { sha256: null, headerSha256: null };
  const source = {
    size: out.size,
    async *open() {
      const h = createHash("sha256");
      const hh = createHash("sha256");
      let at = 0;
      for await (const c of out.open()) {
        h.update(c);
        if (at < out.bodyStart) hh.update(c.subarray(0, out.bodyStart - at));
        at += c.length;
        yield c;
      }
      state.sha256 = h.digest("hex");
      state.headerSha256 = hh.digest("hex");
    },
  };
  return { state, source };
}

// Least recently used first; an entry's bytes may be set once known (weigh).
function lru(maxEntries, maxBytes) {
  const map = new Map(); // key -> { v, bytes }
  let bytes = 0;
  const evict = (keep) => {
    for (const [k, e] of map) {
      if (map.size <= maxEntries && bytes <= maxBytes) break;
      if (k === keep) continue;
      map.delete(k);
      bytes -= e.bytes;
    }
  };
  return {
    get size() { return map.size; },
    get bytes() { return bytes; },
    get(k) {
      const e = map.get(k);
      if (!e) return undefined;
      map.delete(k);
      map.set(k, e);
      return e.v;
    },
    set(k, v, b = 0) {
      if (map.has(k)) bytes -= map.get(k).bytes;
      map.delete(k);
      map.set(k, { v, bytes: b });
      bytes += b;
      evict(k);
    },
    weigh(k, b) {
      const e = map.get(k);
      if (!e) return;
      bytes += b - e.bytes;
      e.bytes = b;
      evict(k);
    },
    delete(k) {
      const e = map.get(k);
      if (e) { bytes -= e.bytes; map.delete(k); }
    },
  };
}

export function createPackItemStore({ blobs, nameFor, packs = [], targetBytes = PACK_TARGET_BYTES, headerCache = 64, headerCacheBytes = HEADER_CACHE_BYTES, meta = {}, spoolDir = null }) {
  let flushNo = 0;
  let open = null; // { name, writer }
  let chain = Promise.resolve();
  const pending = new Map(); // name -> writer, until its upload ends
  const failed = new Map(); // name -> reason
  const table = new Map(packs.map((p) => [p.name, p])); // name -> { name, loc, size, sha256, headerSha256, items }
  const uploaded = [];
  const written = [];
  const headers = lru(headerCache, headerCacheBytes);
  const windows = lru(Infinity, WINDOW_CACHE_BYTES);
  const counts = { rangeReads: 0, uploads: 0 };

  async function resolve(name) {
    const row = table.get(name);
    if (!row) throw new PackUnknownError(name);
    const st = await blobs.stat(row.loc);
    if (!st) throw new StoreNotFoundError(`pack item store: pack ${name} not found at ${row.loc}`);
    if (st.size !== row.size) throw new PackRowMismatchError(row.loc, "size", row.size, st.size);
    return row;
  }

  // Opens the pack, keeping the bytes read from offset 0 until the header is parsed so
  // they can be hashed against the row's headerSha256.
  async function openChecked(row) {
    const { loc, size } = row;
    let head = row.headerSha256 ? [] : null;
    const p = await openPack({
      name: loc, size,
      readRange: async (off, len) => {
        counts.rangeReads++;
        const b = await blobs.readRange(loc, off, len);
        if (head) head.push(b);
        return b;
      },
    });
    if (head) {
      const got = createHash("sha256").update(Buffer.concat(head).subarray(0, p.bodyStart)).digest("hex");
      head = null;
      if (got !== row.headerSha256) throw new PackRowMismatchError(loc, "headerSha256", row.headerSha256, got);
    }
    return p;
  }

  function pack(name) {
    let p = headers.get(name);
    if (!p) {
      p = (async () => openChecked(await resolve(name)))();
      p.then((o) => headers.weigh(name, o.bodyStart), () => headers.delete(name));
      headers.set(name, p);
    }
    return p;
  }

  async function flush() {
    if (!open) return;
    const { name, writer } = open;
    open = null;
    flushNo++;
    const out = await writer.finish();
    const { state, source } = hashingSource(out);
    try {
      const { loc, size } = await blobs.upload(name, source);
      const row = { name, loc, size, sha256: state.sha256, headerSha256: state.headerSha256, items: writer.count };
      table.set(name, row);
      uploaded.push(row);
      counts.uploads++;
    } catch (err) {
      failed.set(name, err.message);
      throw err;
    } finally {
      pending.delete(name);
      await out.dispose();
    }
  }

  async function putNow(bytes) {
    if (!open) {
      const name = nameFor(flushNo);
      const spoolFile = spoolDir ? path.join(spoolDir, `${name}.spool`) : undefined;
      open = { name, writer: createPackWriter({ meta: { ...meta, flush: flushNo }, spoolFile }) };
      pending.set(name, open.writer);
    }
    const { name, writer } = open;
    const entry = await writer.add(bytes, { enc: "raw" });
    const ref = `${name}#${entry.id}`;
    written.push(ref);
    if (writer.size >= targetBytes) await flush();
    return ref;
  }
  // Puts and flushes run one at a time so item ids and flush numbers stay in order.
  const serial = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  async function locate(ref) {
    const { name, id } = parseRef(ref);
    if (failed.has(name)) throw new PackLostError(ref, failed.get(name));
    const writer = pending.get(name);
    if (writer) {
      if (id >= writer.count) throw new StoreNotFoundError(`pack item store: missing item ${ref}`);
      return { name, id, writer, it: writer.items[id] };
    }
    const p = await pack(name);
    return { name: p.name, id, pack: p, it: p.entry(id) };
  }

  // A read of a pending item that loses the race with its flush finds the spool
  // disposed; by then the pack is uploaded (or failed), so it is located again once.
  async function withLocation(ref, fn) {
    try {
      return await fn(await locate(ref));
    } catch (err) {
      if (!(err instanceof PackSpoolDisposedError)) throw err;
      return fn(await locate(ref));
    }
  }

  async function window(ref, at) {
    let w = windows.get(ref);
    if (!w) {
      const whole = at.it.len <= HEAD_WINDOW;
      w = whole ? await at.pack.readItem(at.id) : await at.pack.readItemRange(at.id, 0, HEAD_WINDOW);
      windows.set(ref, w, w.length);
    }
    return w;
  }

  return {
    put: (bytes) => serial(() => putNow(bytes)),
    get: (ref) => withLocation(ref, async (at) => {
      if (at.writer) return verifyItem(at.name, at.id, at.it, await at.writer.readStored(at.id));
      return at.pack.readItem(at.id);
    }),
    getRange: (ref, offset, length) => withLocation(ref, async (at) => {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > at.it.len) {
        throw new Error(`pack item store: range ${offset}+${length} outside item ${ref} of ${at.it.len} bytes`);
      }
      if (at.writer) return at.writer.readStored(at.id, offset, length);
      if (offset + length <= Math.min(at.it.len, HEAD_WINDOW)) {
        return Buffer.from((await window(ref, at)).subarray(offset, offset + length));
      }
      return at.pack.readItemRange(at.id, offset, length);
    }),
    async has(ref) {
      try {
        await locate(ref);
        return true;
      } catch (err) {
        if (err instanceof StoreNotFoundError || err instanceof PackLostError || err instanceof PackUnknownError || err?.name === "PackItemRangeError") return false;
        throw err;
      }
    },
    // An item is never deleted alone: a pack leaves when no bundle names any of its
    // items (the sweep, design 4.3), so item deletion is by reference and records nothing.
    async delete() {},
    async list() {
      return [...written].sort();
    },
    close: () => serial(async () => {
      await flush();
      return { packs: uploaded.map((r) => ({ ...r })) };
    }),
    stats: () => ({ packs: uploaded.length, uploads: counts.uploads, rangeReads: counts.rangeReads, cachedHeaders: headers.size, cachedHeaderBytes: headers.bytes }),
  };
}
