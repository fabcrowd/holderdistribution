// Size: 2,000,000 rows written and read bucket by bucket with bounded heap growth,
// and measured bytes per base row and per change row for a two-field value.
import { describe, it, expect } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { createMemoryStore } from "./itemStore.js";
import { createIndex, currentPosition } from "./tableIndex.js";
import { writeInitialTable, writePart } from "./tableWrite.js";
import { walkPosition } from "./tableRead.js";
import { bucketCount } from "./buckets.js";

const ROWS = 2_000_000;
const LAYOUT = { L: 5, p: 0 }; // 32 buckets of about 62,500 rows
const HEAP_BOUND = 192 * 1024 * 1024; // a whole table in memory would be well over 500 MB
const FNV_PRIME = 0x01000193;

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

function fnvStep(h, byte) {
  return Math.imul(h ^ byte, FNV_PRIME) >>> 0;
}
function fnvOf(str, h = 0x811c9dc5) {
  for (let i = 0; i < str.length; i++) h = fnvStep(h, str.charCodeAt(i));
  return h;
}
const HEX = "0123456789abcdef";

// The n-th 20-byte hex key of bucket b: a prefix from (b, n) plus a two-char suffix
// chosen so the key's hash lands in b (only the low 5 bits matter at L = 5, p = 0).
function keyFor(b, n) {
  const prefix = `0x${b.toString(16).padStart(4, "0")}${n.toString(16).padStart(8, "0")}${"9e3779b97f4a7c15f4a7c15f".slice(0, 26)}`;
  const h0 = fnvOf(prefix);
  for (let i = 0; i < 256; i++) {
    const s = HEX[i >> 4] + HEX[i & 15];
    const h = fnvStep(fnvStep(h0, s.charCodeAt(0)), s.charCodeAt(1));
    if ((h & 31) === b) return prefix + s;
  }
  throw new Error(`no suffix for bucket ${b} key ${n}`);
}

function valueFor(b, n) {
  const balance = BigInt((b * 7919 + n * 104729) % 1_000_000_007) * 1_000_000_000n + BigInt(n) + 1n;
  return [balance, n % 10 === 0 ? balance / 3n : 0n];
}

describe("store size", () => {
  it("writes and reads 2,000,000 rows bucket by bucket with bounded heap", async () => {
    const store = createMemoryStore();
    let index = createIndex({ table: "acct", fields: 2, rowsPerBucket: 65536 });
    const B = bucketCount(LAYOUT);
    const per = Math.ceil(ROWS / B);
    gc();
    const start = process.memoryUsage().heapUsed;
    let peak = 0;
    const sample = () => {
      gc();
      peak = Math.max(peak, process.memoryUsage().heapUsed - start);
    };
    async function* buckets() {
      for (let b = 0; b < B; b++) {
        const rows = new Map();
        for (let n = 0; n < per && b * per + n < ROWS; n++) rows.set(keyFor(b, n), valueFor(b, n));
        yield { bucket: b, rows };
        sample();
      }
    }
    index = (await writeInitialTable({ store, index, day: 1, layout: LAYOUT, buckets: buckets() })).index;
    let read = 0;
    for await (const b of walkPosition(store, index, currentPosition(index))) {
      read += b.rows.size;
      sample();
    }
    expect(read).toBe(ROWS);
    const baseBytes = index.buckets.reduce((s, b) => s + store.items.get(b.base.ref).length, 0);

    const changes = new Map();
    for (let i = 0; i < 100_000; i++) {
      const b = i % B;
      const n = Math.floor(i / B) * 7;
      changes.set(keyFor(b, n), [valueFor(b, n)[0] + 12345n, 0n]);
    }
    const r = await writePart({ store, index, day: 2, changes });
    const partBytes = store.items.get(r.ref).length;
    sample();
    const perBase = baseBytes / ROWS;
    const perChange = partBytes / r.rows;
    console.log(`size: ${ROWS} rows, base ${perBase.toFixed(1)} B/row, change ${perChange.toFixed(1)} B/row (${r.rows} rows), peak heap growth ${(peak / 1048576).toFixed(0)} MiB`);
    expect(peak).toBeLessThan(HEAP_BOUND);
  }, 120000);
});
