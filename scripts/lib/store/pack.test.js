// The container of design 2.1 section 7.2: round trips, header read budget, named
// corruption errors, piecewise writing, and the writer's memory bound.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import v8 from "node:v8";
import vm from "node:vm";
import {
  createPackWriter, openPack, packToBuffer, PackError, PackTruncatedError, PackMagicError,
  PackHeaderLengthError, PackItemRangeError, PackHashError, PackSizeError, PackSpoolDisposedError, HEADER_FIRST_READ,
} from "./pack.js";
import { rng } from "./storeTestKit.js";

const META = { class: "live", kind: "holders", day: "2026-11-18", run: "1a1", lane: 0, flush: 0, slugs: ["c1"] };

// Deterministic bytes: runs of a small alphabet, so brotli has work but data is not constant.
export function genBytes(size, seed = 1) {
  const next = rng(seed);
  const out = Buffer.allocUnsafe(size);
  let i = 0;
  while (i < size) {
    const v = Math.floor(next() * 256);
    const run = 1 + Math.floor(next() * 16);
    out.fill(v, i, Math.min(size, i + run));
    i += run;
  }
  return out;
}

function ranger(buf, counter = { n: 0 }) {
  return {
    counter,
    size: buf.length,
    async readRange(off, len) {
      counter.n++;
      return Buffer.from(buf.subarray(off, off + len));
    },
  };
}

async function packOf(items, opts = {}) {
  const w = createPackWriter({ meta: META, ...opts });
  for (const it of items) await w.add(it.bytes, it.info ?? {});
  return packToBuffer(await w.finish());
}

async function readAll(buf, name = "p.test") {
  const r = ranger(buf);
  const pack = await openPack({ name, size: r.size, readRange: r.readRange });
  const out = [];
  for (let i = 0; i < pack.header.items.length; i++) out.push(await pack.readItem(i));
  return { pack, out };
}

describe("pack round trip", () => {
  it("1 and 2 items, one of them empty", async () => {
    for (const items of [[genBytes(1000)], [Buffer.alloc(0), genBytes(5000, 2)]]) {
      const buf = await packOf(items.map((bytes) => ({ bytes })));
      const { out, pack } = await readAll(buf);
      expect(out.map((b) => b.toString("hex"))).toEqual(items.map((b) => b.toString("hex")));
      expect(pack.header.schema).toBe(1);
      expect(buf.subarray(0, 4).toString("latin1")).toBe("HDB1");
    }
  });

  it("5,000 small items", async () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ bytes: i % 7 === 0 ? Buffer.alloc(0) : genBytes(50 + (i % 300), i), info: { slug: "c1", path: `f${i}` } }));
    const buf = await packOf(items);
    const { out, pack } = await readAll(buf);
    expect(out.every((b, i) => b.equals(items[i].bytes))).toBe(true);
    expect(pack.header.items[3].path).toBe("f3");
  }, 30000);

  it("a 30 MB item", async () => {
    const big = genBytes(30_000_000, 9);
    const buf = await packOf([{ bytes: genBytes(10) }, { bytes: big }]);
    const { out } = await readAll(buf);
    expect(out[1].equals(big)).toBe(true);
  }, 30000);

  it("raw items can be read by sub-range", async () => {
    const a = genBytes(4000, 3);
    const buf = await packOf([{ bytes: genBytes(10) }, { bytes: a, info: { enc: "raw" } }]);
    const r = ranger(buf);
    const pack = await openPack({ name: "p", size: r.size, readRange: r.readRange });
    r.counter.n = 0;
    expect((await pack.readItemRange(1, 100, 50)).equals(a.subarray(100, 150))).toBe(true);
    expect(r.counter.n).toBe(1);
    await expect(pack.readItemRange(1, 3990, 20)).rejects.toBeInstanceOf(PackItemRangeError);
  });
});

describe("header read budget", () => {
  it("at most two range reads for the header, then one per item", async () => {
    for (const n of [1, 3000]) {
      const buf = await packOf(Array.from({ length: n }, (_, i) => ({ bytes: genBytes(20, i), info: { path: `some/longer/path/name-${i}.json` } })));
      const r = ranger(buf);
      const pack = await openPack({ name: "p", size: r.size, readRange: r.readRange });
      expect(r.counter.n).toBeLessThanOrEqual(2);
      if (n === 1) expect(r.counter.n).toBe(1);
      r.counter.n = 0;
      await pack.readItem(n - 1);
      expect(r.counter.n).toBe(1);
    }
    expect(HEADER_FIRST_READ).toBeGreaterThan(8);
  });
});

describe("named corruption errors", () => {
  const good = async () => packOf([{ bytes: genBytes(3000, 1) }, { bytes: genBytes(3000, 2) }]);
  const open = (buf, name = "p.bad") => { const r = ranger(buf); return openPack({ name, size: r.size, readRange: r.readRange }); };

  it("truncated", async () => {
    const buf = await good();
    await expect(open(buf.subarray(0, 5))).rejects.toBeInstanceOf(PackTruncatedError);
    const err = await open(buf.subarray(0, buf.length - 10)).catch((e) => e);
    expect(err).toBeInstanceOf(PackTruncatedError);
    expect(err.message).toContain("p.bad");
  });

  it("trailing bytes after the body (review minor)", async () => {
    const buf = Buffer.concat([await good(), Buffer.from("JUNK")]);
    await expect(open(buf)).rejects.toBeInstanceOf(PackSizeError);
  });

  it("a read from a disposed spool throws instead of returning zeros (review minor)", async () => {
    const w = createPackWriter({ meta: META });
    await w.add(Buffer.from("hello"), { enc: "raw" });
    const out = await w.finish();
    await out.dispose();
    await expect(w.readStored(0)).rejects.toBeInstanceOf(PackSpoolDisposedError);
  });

  it("wrong magic", async () => {
    const buf = Buffer.from(await good());
    buf.write("XDB1", 0, "latin1");
    await expect(open(buf)).rejects.toBeInstanceOf(PackMagicError);
  });

  it("header length beyond the file", async () => {
    const buf = Buffer.from(await good());
    buf.writeUInt32BE(buf.length, 4);
    await expect(open(buf)).rejects.toBeInstanceOf(PackHeaderLengthError);
  });

  it("item range beyond the file", async () => {
    const buf = await good();
    const hlen = buf.readUInt32BE(4);
    const header = JSON.parse(buf.subarray(8, 8 + hlen).toString("utf8"));
    header.items[1].len += 5000;
    const hb = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(8);
    prefix.write("HDB1", 0, "latin1");
    prefix.writeUInt32BE(hb.length, 4);
    const pack = await open(Buffer.concat([prefix, hb, buf.subarray(8 + hlen)]));
    const err = await pack.readItem(1).catch((e) => e);
    expect(err).toBeInstanceOf(PackItemRangeError);
    expect(err.message).toMatch(/p\.bad.*item 1/);
  });

  it("hash mismatch names pack and item", async () => {
    const buf = Buffer.from(await good());
    const pack0 = await open(buf);
    const it1 = pack0.header.items[1];
    const at = pack0.bodyStart + it1.off;
    // Replace item 1 with item 0's compressed bytes when they fit, else flip a byte.
    const it0 = pack0.header.items[0];
    if (it0.len <= it1.len) buf.copy(buf, at, pack0.bodyStart + it0.off, pack0.bodyStart + it0.off + it0.len);
    else buf[at + 2] ^= 0xff;
    const pack = await open(buf);
    const err = await pack.readItem(1).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(err.message).toMatch(/p\.bad.*item 1/);
    const raw = Buffer.from(await packOf([{ bytes: genBytes(500, 4), info: { enc: "raw" } }]));
    raw[raw.length - 1] ^= 1;
    await expect((await open(raw)).readItem(0)).rejects.toBeInstanceOf(PackHashError);
  });
});

describe("writer", () => {
  it("a pack written in pieces equals one written at once", async () => {
    const items = Array.from({ length: 50 }, (_, i) => genBytes(1000 + i * 37, i));
    const once = await packOf(items.map((bytes) => ({ bytes, info: { madeAt: "t" } })));
    const w = createPackWriter({ meta: META });
    for (const bytes of items) {
      await new Promise((r) => setImmediate(r));
      await w.add(bytes, { madeAt: "t" });
    }
    expect((await packToBuffer(await w.finish())).equals(once)).toBe(true);
  });

  it("2,000 items of 100 KB with a file spool stay under the memory bound", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-mem-"));
    try {
      gc();
      const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
      let peak = 0;
      const w = createPackWriter({ meta: META, spoolFile: path.join(dir, "spool") });
      const src = genBytes(100_000, 5);
      for (let i = 0; i < 2000; i++) {
        src.writeUInt32BE(i, 0);
        // raw: brotli at quality 9 on 200 MB takes over 20 s; the bound tested is the writer's buffering.
        await w.add(src, { path: `f${i}`, enc: i % 100 === 0 ? "br" : "raw" });
        if (i % 200 === 0) {
          gc();
          const m = process.memoryUsage();
          peak = Math.max(peak, m.heapUsed + m.arrayBuffers - before);
        }
      }
      const out = await w.finish();
      expect(out.size).toBeGreaterThan(8);
      // Bound: one item in flight plus the header (2,000 entries), never the pack.
      expect(peak).toBeLessThan(32 * 1024 * 1024);
      await out.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});
