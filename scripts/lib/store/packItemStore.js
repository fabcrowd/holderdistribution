// The item-store seam of itemStore.js on packs: one night's puts are buffered into a
// pack, uploaded through the blob store when the pack reaches its target size and at
// close(), and read back by byte range.
//
// Whose item is whose (design 2.1 section 7.2): put(bytes, info) records the item's type, coin
// (slug), path, table, bucket and day in the pack header (packItemInfo.js) and the header's
// `slugs` is the set of the coins of its items (pack.js), so the sweep and adoption read a
// pack's coins from its header. A store made with `requireCoin` (every lane store) refuses a
// put with no coin (PackCoinRequiredError); without it the plain put(bytes) of the table code
// still works, writing type "item" and no coin, and a pack holding such an item has no coin
// list (the sweep then keeps and reports it, as before). forCoin(slug) is the item-store
// interface (itemStore.js) with the coin filled in, so the table code never names a coin.
//
// Coin by coin (design 9.1 end step 5): endCoin(slug) says a coin is finished in this store and
// flushes the open pack when it holds `coinLimit` coins (PACK_COIN_LIMIT, 16) or `targetBytes`
// (PACK_TARGET_BYTES). The limits are hard inside put() too: an item that would take the open pack
// over the byte target, or a coin not yet in the pack when it already holds `coinLimit` coins,
// flushes the pack first, so interleaved views and a lane that forgets endCoin cannot overrun
// them; a pack is over the byte target only when one item alone is (and an item above
// `maxItemBytes`, PACK_MAX_ITEM_BYTES, is a named error). A coin's items can therefore span two
// packs. What lets a reader resolve them is the pack table: a reference names its pack and the
// pack table row (or the bundle's `packs`) gives the location, so a coin is never required to
// sit in one pack; both packs list the coin in `slugs`.
//
// Memory: one open pack (under targetBytes) per store. Per finished coin the store keeps nothing:
// the refs a view lists are dropped at endCoin(slug), and the store keeps no list of every ref
// when it requires a coin. It keeps one row per uploaded pack (about 250 bytes, which the lane
// needs for its bundles) and the lost coins (below), which grow only with failures. stats()
// shows trackedCoins, trackedRefs and lostCoins.
//
// Rows before close(): rows() returns copies of the rows of the packs already uploaded. A row
// exists only after the upload returned a location, so a bundle written before the lane's last
// flush can name items of earlier packs; a pack whose upload failed has no row and its refs
// throw PackLostError. addRows() takes the rows a bundle carries into a read-only store.
//
// A lost pack fails its coins: when an upload fails, every coin with an item in that pack is
// recorded in `failedCoins` (a Map a lane shares between its stores), and from then on put, list
// and has on that coin's view throw PackLostError and list() never returns a ref of the pack.
// lostCoins() names them. put(bytes, info, { guard }) calls guard(pack name) before the item is
// added, with the name of the pack it will land in; a guard that throws leaves nothing behind.
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
// HEADER_CACHE_BYTES of header JSON. With `sharedHeaders` (packHeaderCache.js) a first open goes
// through that cache, which many stores and a whole publish share; the cache then makes the reads.
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
import { createPackWriter, verifyItem, PACK_TARGET_BYTES, PACK_COIN_LIMIT, PACK_MAX_ITEM_BYTES, PackSpoolDisposedError } from "./pack.js";
import { checkSlug, infoForCoin, itemInfoFor, PackItemTooLargeError } from "./packItemInfo.js";
import { HEADER_CACHE_BYTES, PackRowMismatchError, openVerified } from "./packHeaderCache.js";
import { lru } from "./packLru.js";
import { NameError, parsePackName } from "./packNames.js";
import { StoreNotFoundError } from "./blobStore.js";

export const HEAD_WINDOW = 64 * 1024;
const WINDOW_CACHE_BYTES = 8 * 1024 * 1024;
// About 250 bytes of header per item: 16 MiB holds the headers of about 65,000 items.
export { HEADER_CACHE_BYTES, PackRowMismatchError };

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

export class PackRowConflictError extends Error {
  constructor(name, have, got) {
    super(`pack item store: pack ${name} is at ${have} in this store's table, a stored location is never replaced, and the row given says ${got}`);
    this.name = "PackRowConflictError";
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

// The flush number of a pack name is the one in the name (a lane hands out one counter per class);
// a name that is not a pack name keeps the store's own count.
function flushOf(name, fallback) {
  try {
    return parsePackName(name).flush;
  } catch (err) {
    if (err instanceof NameError) return fallback;
    throw err;
  }
}

export function createPackItemStore({
  blobs, nameFor, packs = [], targetBytes = PACK_TARGET_BYTES, coinLimit = PACK_COIN_LIMIT, maxItemBytes = PACK_MAX_ITEM_BYTES, requireCoin = false,
  headerCache = 64, headerCacheBytes = HEADER_CACHE_BYTES, sharedHeaders = null, failedCoins = new Map(), meta = {}, spoolDir = null,
}) {
  let flushNo = 0;
  let open = null; // { name, writer, coins: Set of the coins of its items }
  let chain = Promise.resolve();
  const pending = new Map(); // name -> writer, until its upload ends
  const failed = new Map(); // name -> reason
  const table = new Map(packs.map((p) => [p.name, p])); // name -> { name, loc, size, sha256, headerSha256, items }
  const uploaded = [];
  let written = []; // every ref, kept only by a store that does not require a coin (the table code's tests)
  const byCoin = new Map(); // slug -> refs of a coin not yet finished: appended to, never copied
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

  // The row is checked when the pack is first opened (packHeaderCache.js openVerified); with a
  // shared cache the cache opens it, and counts the reads.
  async function openChecked(row) {
    if (sharedHeaders) return sharedHeaders.open(blobs, row);
    return openVerified({ blobs, row, onRead: () => { counts.rangeReads++; } });
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

  // The coins of a lost pack are failed, and nothing of the pack stays listed.
  function losePack(name, coins, reason) {
    failed.set(name, reason);
    for (const slug of coins) {
      failedCoins.set(slug, reason);
      byCoin.delete(slug);
    }
    written = written.filter((ref) => !ref.startsWith(`${name}#`));
  }

  async function flush() {
    if (!open) return;
    const { name, writer, coins } = open;
    open = null;
    flushNo++;
    let out;
    try {
      out = await writer.finish();
      const { state, source } = hashingSource(out);
      const { loc, size } = await blobs.upload(name, source);
      const row = { name, loc, size, sha256: state.sha256, headerSha256: state.headerSha256, items: writer.count };
      table.set(name, row);
      uploaded.push(row);
      counts.uploads++;
    } catch (err) {
      losePack(name, coins, err.message);
      throw err;
    } finally {
      pending.delete(name);
      if (out) await out.dispose();
    }
  }

  // The byte target ends a pack inside a coin; the coin limit only at a coin's end.
  const limitReached = (atCoinEnd) => open !== null && (open.writer.size >= targetBytes || (atCoinEnd && open.coins.size >= coinLimit));
  // Would adding this item break a limit of the open pack? (a pack with no item takes any item)
  const wouldOverrun = (size, slug) => open !== null && open.writer.count > 0
    && (open.writer.size + size > targetBytes || (slug !== null && !open.coins.has(slug) && open.coins.size >= coinLimit));
  const lostError = (slug) => new PackLostError(`coin ${slug}`, failedCoins.get(slug));
  const checkNotLost = (slug) => {
    if (failedCoins.has(slug)) throw lostError(slug);
  };

  async function putNow(bytes, info, guard) {
    if (info.slug !== null) checkNotLost(info.slug);
    if (wouldOverrun(bytes.length, info.slug)) await flush();
    const name = open ? open.name : nameFor(flushNo);
    if (guard) guard(name);
    if (!open) {
      const spoolFile = spoolDir ? path.join(spoolDir, `${name}.spool`) : undefined;
      open = { name, writer: createPackWriter({ meta: { ...meta, flush: flushOf(name, flushNo) }, spoolFile }), coins: new Set() };
      pending.set(name, open.writer);
    }
    const { writer, coins } = open;
    const entry = await writer.add(bytes, { ...info, enc: "raw" });
    const ref = `${name}#${entry.id}`;
    if (info.slug === null) {
      written.push(ref);
    } else {
      coins.add(info.slug);
      if (!requireCoin) written.push(ref);
      const mine = byCoin.get(info.slug);
      if (mine) mine.push(ref);
      else byCoin.set(info.slug, [ref]);
    }
    if (limitReached(false)) await flush();
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

  const store = {
    async put(bytes, info, { guard = null } = {}) {
      const item = itemInfoFor(info, { requireCoin });
      if (bytes.length > maxItemBytes) throw new PackItemTooLargeError(bytes.length, maxItemBytes);
      return serial(() => putNow(bytes, item, guard));
    },
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
    // Every ref put and still readable (of the coins not yet finished, for a store that requires a coin).
    async list() {
      return requireCoin ? [...byCoin.values()].flat().sort() : [...written].sort();
    },
    forCoin(slug) {
      checkSlug(slug);
      return {
        put: async (bytes, info, opts) => store.put(bytes, infoForCoin(slug, info), opts),
        get: (ref) => store.get(ref),
        getRange: (ref, offset, length) => store.getRange(ref, offset, length),
        has: async (ref) => {
          checkNotLost(slug);
          return store.has(ref);
        },
        delete: (ref) => store.delete(ref),
        list: async () => {
          checkNotLost(slug);
          return [...(byCoin.get(slug) ?? [])].sort();
        },
      };
    },
    // The coin is finished here: its refs are dropped from the store's memory (the caller holds them),
    // and the pack is flushed when a limit is reached. A failed coin is not flushed for.
    async endCoin(slug) {
      checkSlug(slug);
      return serial(async () => {
        byCoin.delete(slug);
        if (failedCoins.has(slug) || !limitReached(true)) return { flushed: false };
        await flush();
        return { flushed: true };
      });
    },
    rows: () => uploaded.map((r) => ({ ...r })),
    addRows(rows) {
      for (const r of rows) {
        const have = table.get(r.name);
        if (!have) table.set(r.name, { ...r });
        else if (have.loc !== r.loc || have.size !== r.size) throw new PackRowConflictError(r.name, have.loc, r.loc);
      }
    },
    // The header's entry of an item (type, coin, path, ...), read from the pack header only.
    entryOf: (ref) => withLocation(ref, async (at) => ({ ...at.it })),
    lostCoins: () => [...failedCoins.keys()].sort(),
    close: () => serial(async () => {
      await flush();
      return { packs: uploaded.map((r) => ({ ...r })) };
    }),
    stats: () => ({
      packs: uploaded.length, uploads: counts.uploads, rangeReads: counts.rangeReads, cachedHeaders: headers.size, cachedHeaderBytes: headers.bytes,
      openItems: open ? open.writer.count : 0, openBytes: open ? open.writer.size : 0,
      trackedCoins: byCoin.size, trackedRefs: [...byCoin.values()].reduce((n, l) => n + l.length, 0), lostCoins: failedCoins.size,
    }),
  };
  return store;
}
