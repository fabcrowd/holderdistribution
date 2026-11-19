// Reads which coins a pack lists, from its header only (design 2.1 section 7.2, `slugs`).
// openPack reads the first HEADER_FIRST_READ bytes plus the 8-byte prefix in one range
// read, and a second read only when the header is longer: at most 2 range reads per pack,
// and never an item or the body. The counter records the reads and the bytes, so a run
// can state them.
//
// The header carries `slugs` only when the writer passed it in the pack's `meta`
// (pack.js, packItemStore.js `meta`): nothing in the store code adds it by itself. A header
// without a `slugs` list of strings answers null, which the plan keeps and reports.
import { openPack, PackError } from "./pack.js";
import { StoreError } from "./blobStore.js";

export const HEADER_READS_PER_PACK = 2;

export function headerCounter() {
  return { packs: 0, reads: 0, bytes: 0 };
}

// -> { coins: string[] }, or { coins: null, failure, error } where failure is "unreadable" (the
// header could not be read) or "no-coin-list" (it was read and has no `slugs` list).
export async function coinsFromHeader({ blobs, entry, counter }) {
  counter.packs++;
  const readRange = async (offset, length) => {
    counter.reads++;
    counter.bytes += length;
    return blobs.readRange(entry.loc, offset, length);
  };
  try {
    const { header } = await openPack({ name: entry.loc, size: entry.size, readRange });
    if (!Array.isArray(header.slugs) || header.slugs.some((s) => typeof s !== "string")) {
      return { coins: null, failure: "no-coin-list", error: `${entry.loc}: the header has no list of coins (slugs)` };
    }
    return { coins: [...header.slugs] };
  } catch (err) {
    if (err instanceof PackError || err instanceof StoreError) return { coins: null, failure: "unreadable", error: err.message };
    throw err;
  }
}
