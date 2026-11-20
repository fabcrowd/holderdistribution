// Opened pack headers shared by many readers: one cache for a whole publish, so a pack that up to
// 16 coins share is read once, not once per coin and chain entry (design 2.1 section 9.2, and the
// cost statement of acceptChain.js). A pack item store takes it as `sharedHeaders`.
//
// The key is the pack's location with the size and header hash of its table row: the same pack
// reached through a row with another hash (a crafted pack under the same name) is another entry.
// The header bytes of a first read are hashed against the row's `headerSha256`, as a store does
// (PackRowMismatchError). The cache is bounded in bytes of header (about 250 bytes an item), the
// least recently used entry leaving first; a failed open is not kept. Concurrent opens of one key
// share one read. `stats()` gives { entries, bytes, reads, hits }: `reads` counts the range reads
// the cache made, `hits` the opens it answered from memory.
import { createHash } from "node:crypto";
import { openPack } from "./pack.js";

export const HEADER_CACHE_BYTES = 16 * 1024 * 1024;

export class PackRowMismatchError extends Error {
  constructor(loc, field, want, got) {
    super(`pack item store: ${loc} does not match its pack table row: ${field} is ${got}, the row says ${want}`);
    this.name = "PackRowMismatchError";
  }
}

// Opens the pack, keeping the bytes read from offset 0 until the header is parsed so they can be
// hashed against the row's headerSha256. `onRead` is called for every range read.
export async function openVerified({ blobs, row, onRead = () => {} }) {
  const { loc, size } = row;
  let head = row.headerSha256 ? [] : null;
  const p = await openPack({
    name: loc, size,
    readRange: async (off, len) => {
      onRead();
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

const keyOf = (row) => `${row.loc}|${row.size}|${row.headerSha256 ?? ""}`;

export function createHeaderCache({ maxBytes = HEADER_CACHE_BYTES } = {}) {
  const map = new Map(); // key -> { p: Promise<opened pack>, bytes }, least recently used first
  let bytes = 0;
  const counts = { reads: 0, hits: 0 };
  const drop = (key) => {
    const e = map.get(key);
    if (e) { bytes -= e.bytes; map.delete(key); }
  };
  function evict(keep) {
    for (const [k, e] of map) {
      if (bytes <= maxBytes) break;
      if (k !== keep && e.bytes > 0) drop(k);
    }
  }
  return {
    open(blobs, row) {
      const key = keyOf(row);
      const hit = map.get(key);
      if (hit) {
        counts.hits++;
        map.delete(key);
        map.set(key, hit);
        return hit.p;
      }
      const entry = { p: openVerified({ blobs, row, onRead: () => { counts.reads++; } }), bytes: 0 };
      map.set(key, entry);
      entry.p.then((o) => {
        if (map.get(key) !== entry) return;
        entry.bytes = o.bodyStart;
        bytes += o.bodyStart;
        evict(key);
      }, () => { if (map.get(key) === entry) map.delete(key); });
      return entry.p;
    },
    stats: () => ({ entries: map.size, bytes, reads: counts.reads, hits: counts.hits }),
  };
}
