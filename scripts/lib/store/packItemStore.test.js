// The item-store seam on packs: reads before and after a flush, pack counts, the
// crash contract, the bounded header cache, and the range reads a night makes.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createPackItemStore, PackLostError, PackUnknownError } from "./packItemStore.js";
import { folderBackend } from "./blobStoreFolder.js";
import { packName } from "./packNames.js";
import { genBytes } from "./pack.test.js";
import { rng } from "./storeTestKit.js";
import { createIndex, currentPosition } from "./tableIndex.js";
import { writeInitialTable, writePart } from "./tableWrite.js";
import { rowsAt } from "./tableRead.js";
import { bucketOf } from "./buckets.js";

const nameFor = (flush) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 5, attempt: 1, lane: 0, flush });

async function backend() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pis-"));
  return folderBackend(dir, { assetLimit: 900 });
}

function counting(blobs) {
  const calls = { upload: 0, readRange: 0 };
  return {
    calls,
    ...blobs,
    upload: (...a) => { calls.upload++; return blobs.upload(...a); },
    readRange: (...a) => { calls.readRange++; return blobs.readRange(...a); },
  };
}

describe("pack item store", () => {
  it("reads before and after the flush, refs survive JSON", async () => {
    const blobs = await backend();
    const s = createPackItemStore({ blobs, nameFor, targetBytes: 1 << 20 });
    const a = genBytes(3000, 1);
    const ref = await s.put(a);
    expect(typeof ref).toBe("string");
    expect((await s.get(ref)).equals(a)).toBe(true);
    expect((await s.getRange(ref, 10, 20)).equals(a.subarray(10, 30))).toBe(true);
    expect(await s.has(ref)).toBe(true);
    const { packs } = await s.close();
    expect(packs.map((p) => [p.name, p.loc, p.items])).toEqual([[nameFor(0), `data-live-1/${nameFor(0)}`, 1]]);
    const fresh = createPackItemStore({ blobs, nameFor, packs: JSON.parse(JSON.stringify(packs)), targetBytes: 1 << 20 });
    const back = JSON.parse(JSON.stringify({ ref })).ref;
    expect((await fresh.get(back)).equals(a)).toBe(true);
    expect((await fresh.getRange(back, 2990, 10)).equals(a.subarray(2990))).toBe(true);
    await expect(fresh.getRange(back, 2995, 10)).rejects.toThrow(/range/);
  });

  it("10,000 small puts make the predicted packs and uploads", async () => {
    const blobs = counting(await backend());
    const target = 1 << 20;
    const s = createPackItemStore({ blobs, nameFor, targetBytes: target });
    const size = 1000;
    for (let i = 0; i < 10_000; i++) {
      const b = Buffer.alloc(size, i & 0xff);
      b.writeUInt32BE(i, 0);
      await s.put(b);
    }
    const { packs } = await s.close();
    // A pack flushes once its items reach the target: ceil(target / size) items each.
    const perPack = Math.ceil(target / size);
    const predicted = Math.ceil(10_000 / perPack);
    expect(packs).toHaveLength(predicted);
    expect(blobs.calls.upload).toBe(predicted);
  }, 30000);

  it("a failed flush throws, and its refs are not readable", async () => {
    const real = await backend();
    const blobs = { ...real, upload: async () => { throw new Error("upload refused"); } };
    const s = createPackItemStore({ blobs, nameFor, targetBytes: 1 << 20 });
    const ref = await s.put(genBytes(100, 3));
    await expect(s.close()).rejects.toThrow(/upload refused/);
    await expect(s.get(ref)).rejects.toBeInstanceOf(PackLostError);
    // A dropped store object: nothing was uploaded, so a fresh reader cannot see it either.
    const dropped = createPackItemStore({ blobs: real, nameFor: (f) => nameFor(f + 50), targetBytes: 1 << 20 });
    const lost = await dropped.put(genBytes(100, 4));
    const reader = createPackItemStore({ blobs: real, nameFor, targetBytes: 1 << 20 });
    await expect(reader.get(lost)).rejects.toBeInstanceOf(PackUnknownError);
  });

  it("the header cache is bounded", async () => {
    const blobs = counting(await backend());
    const s = createPackItemStore({ blobs, nameFor, targetBytes: 1, headerCache: 2 });
    const refs = [];
    for (let i = 0; i < 5; i++) refs.push(await s.put(genBytes(100 * 1024, i)));
    const { packs } = await s.close();
    const r = createPackItemStore({ blobs, nameFor, packs, targetBytes: 1, headerCache: 2 });
    for (const ref of refs) await r.get(ref);
    expect(r.stats().cachedHeaders).toBe(2);
    const before = blobs.calls.readRange;
    await r.get(refs[0]); // evicted: header read again
    expect(blobs.calls.readRange - before).toBe(2);
  });

  it("measures range reads per writePart and rowsAt, and bytes per row packed", async () => {
    const B = 32;
    const layout = { L: 5, p: 0 };
    const rows = 20_000;
    const next = rng(77);
    // Seeded 20-byte hex keys with no shared tail, two-field values as in storeSize.test.js.
    const keys = Array.from({ length: rows }, () => `0x${Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(next() * 16)]).join("")}`);
    const value = (i) => [BigInt(i) * 1_000_000_007n + 12345n, i % 10 === 0 ? BigInt(i) : 0n];
    const blobs = counting(await backend());
    const w = createPackItemStore({ blobs, nameFor, targetBytes: 1 << 30 });
    let index = createIndex({ table: "acct", fields: 2, rowsPerBucket: 65536 });
    const groups = Array.from({ length: B }, () => new Map());
    keys.forEach((k, i) => groups[bucketOf(k, layout)].set(k, value(i)));
    async function* buckets() { for (let b = 0; b < B; b++) yield { bucket: b, rows: groups[b] }; }
    index = (await writeInitialTable({ store: w, index, day: 1, layout, buckets: buckets() })).index;
    const [basePack] = (await w.close()).packs;
    const baseBytes = basePack.size;

    const r1 = createPackItemStore({ blobs, nameFor: (f) => nameFor(f + 10), packs: [basePack], targetBytes: 1 << 30 });
    const changes = new Map(keys.filter((_, i) => i % 10 === 0).map((k, i) => [k, [BigInt(i) + 7n, 0n]]));
    let before = blobs.calls.readRange;
    const part = await writePart({ store: r1, index, day: 2, changes });
    const writeReads = blobs.calls.readRange - before;
    index = part.index;
    const [partPack] = (await r1.close()).packs;
    const partBytes = partPack.size;

    const r2 = createPackItemStore({ blobs, nameFor, packs: [basePack, partPack], targetBytes: 1 << 30 });
    before = blobs.calls.readRange;
    const got = await rowsAt(r2, index, currentPosition(index), 3);
    const rowsAtReads = blobs.calls.readRange - before;
    expect(got.size ?? got.rows?.size).toBeGreaterThan(0);
    console.log(`packs: writePart ${writeReads} range reads (${B} buckets, ${part.rows} change rows); rowsAt ${rowsAtReads} range reads; base ${(baseBytes / rows).toFixed(1)} B/row, change ${(partBytes / part.rows).toFixed(1)} B/row`);
    expect(writeReads).toBeLessThanOrEqual(2 * B + 2);
    expect(rowsAtReads).toBeLessThanOrEqual(6);
  }, 60000);

  it("delete records nothing and does not touch packs", async () => {
    const blobs = await backend();
    const s = createPackItemStore({ blobs, nameFor, targetBytes: 1 << 20 });
    const ref = await s.put(genBytes(10, 1));
    await s.close();
    await s.delete(ref);
    expect((await s.get(ref)).equals(genBytes(10, 1))).toBe(true);
  });

  it("the header cache is bounded by bytes too (review minor)", async () => {
    const blobs = await backend();
    const refs = [];
    const table = [];
    for (let p = 0; p < 3; p++) {
      const w = createPackItemStore({ blobs, nameFor: (f) => nameFor(f + 20 + p), targetBytes: 1 << 30 });
      for (let i = 0; i < 400; i++) refs.push(await w.put(Buffer.from(`p${p}i${i}`)));
      table.push(...(await w.close()).packs);
    }
    const r = createPackItemStore({ blobs, nameFor, packs: table, targetBytes: 1 << 30, headerCache: 64, headerCacheBytes: 60_000 });
    for (const ref of refs) await r.get(ref);
    const { cachedHeaders, cachedHeaderBytes } = r.stats();
    expect(cachedHeaders).toBe(1); // each header is about 100 KB, so only the newest stays
    expect(cachedHeaderBytes).toBeGreaterThan(60_000);
  });

  it("S-A: a ref whose pack is in no table throws PackUnknownError; has() answers false; nothing is found by name", async () => {
    const blobs = await backend();
    const w = createPackItemStore({ blobs, nameFor, targetBytes: 1 << 30 });
    const ref = await w.put(Buffer.from("V1"));
    await w.close();
    const r = createPackItemStore({ blobs: { ...blobs, find: async () => { throw new Error("find must not be called"); } }, nameFor, targetBytes: 1 << 30 });
    await expect(r.get(ref)).rejects.toThrow(new RegExp(`PackUnknownError|pack ${nameFor(0)} is in no pack table`));
    await expect(r.get(ref)).rejects.toBeInstanceOf(PackUnknownError);
    await expect(r.getRange(ref, 0, 1)).rejects.toBeInstanceOf(PackUnknownError);
    expect(await r.has(ref)).toBe(false);
  });

  it("close() rows carry headerSha256, the sha256 of the stored header bytes", async () => {
    const blobs = await backend();
    const s = createPackItemStore({ blobs, nameFor, targetBytes: 1 << 30 });
    await s.put(genBytes(500, 9));
    const [row] = (await s.close()).packs;
    expect(Object.keys(row).sort()).toEqual(["headerSha256", "items", "loc", "name", "sha256", "size"]);
    const bytes = await blobs.readRange(row.loc, 0, row.size);
    const bodyStart = 8 + bytes.readUInt32BE(4);
    const { createHash } = await import("node:crypto");
    expect(row.headerSha256).toBe(createHash("sha256").update(bytes.subarray(0, bodyStart)).digest("hex"));
    expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("a table row is checked on first open: other bytes of the same size and a different size are refused; a row without headerSha256 opens", async () => {
    const blobs = await backend();
    const mk = (f) => createPackItemStore({ blobs, nameFor: () => nameFor(f), targetBytes: 1 << 30 });
    const a = mk(60);
    const refA = await a.put(Buffer.from("balance=100"));
    const [rowA] = (await a.close()).packs;
    // Same length, other bytes, other item hash: the header differs at equal size.
    const b = mk(61);
    await b.put(Buffer.from("balance=999"));
    const [rowB] = (await b.close()).packs;
    expect(rowB.size).toBe(rowA.size);
    // Row A pointed at B's location: same size, other header.
    const swapped = createPackItemStore({ blobs, nameFor, packs: [{ ...rowA, loc: rowB.loc }] });
    await expect(swapped.get(refA)).rejects.toThrow(new RegExp(`${rowB.loc}.*headerSha256 is [0-9a-f]{64}, the row says ${rowA.headerSha256}`));
    // A different size.
    const sized = createPackItemStore({ blobs, nameFor, packs: [{ ...rowA, size: rowA.size + 1 }] });
    await expect(sized.get(refA)).rejects.toThrow(new RegExp(`${rowA.loc}.*size is ${rowA.size}, the row says ${rowA.size + 1}`));
    await expect(sized.has(refA)).rejects.toThrow(/does not match its pack table row/);
    // An older row without headerSha256: size check only.
    const { headerSha256, ...old } = rowA;
    expect(headerSha256).toMatch(/^[0-9a-f]{64}$/);
    const legacy = createPackItemStore({ blobs, nameFor, packs: [old] });
    expect((await legacy.get(refA)).toString()).toBe("balance=100");
  });

  it("a read racing its pack's flush gets the bytes, never zeros (review minor)", async () => {
    const blobs = await backend();
    for (let i = 0; i < 20; i++) {
      const s = createPackItemStore({ blobs, nameFor: (f) => nameFor(f + 40 + i), targetBytes: 1 << 30 });
      const ref = await s.put(Buffer.from("hello world"));
      const closing = s.close();
      const got = s.getRange(ref, 0, 5);
      await closing;
      expect((await got).toString()).toBe("hello");
    }
  });
});
