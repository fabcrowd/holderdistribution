// Least recently used first; an entry's bytes may be set once known (weigh). Bounded by entry
// count and by bytes; used by packItemStore.js for opened headers and item windows.
export function lru(maxEntries, maxBytes) {
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
