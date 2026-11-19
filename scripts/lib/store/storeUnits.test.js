import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createMemoryStore, createFolderStore } from "./itemStore.js";
import { bucketOf, bucketCount, splitLayout, ancestorIn, lineage, layoutForRows } from "./buckets.js";
import { encodeBase, decodeBase, encodePart, readPartHeader, readPartSlice, CODEC_VERSION } from "./codec.js";

describe("buckets", () => {
  it("splits one bucket at a time and keeps every key in its old bucket or the new one", () => {
    let layout = { L: 0, p: 0 };
    const keys = Array.from({ length: 500 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const events = [];
    for (let i = 0; i < 9; i++) {
      const { layout: next, event } = splitLayout(layout);
      events.push(event);
      for (const k of keys) {
        const before = bucketOf(k, layout);
        const after = bucketOf(k, next);
        expect(before === event.split ? [event.split, event.into] : [before]).toContain(after);
        expect(ancestorIn(after, layout)).toBe(before);
      }
      layout = next;
    }
    expect(layout).toEqual({ L: 3, p: 2 });
    expect(bucketCount(layout)).toBe(10);
    expect(lineage(2, events)).toEqual([2, 6]);
    expect(lineage(1, events.slice(1))).toEqual([1, 3, 5, 7, 9]);
    expect(layoutForRows(10, 2)).toEqual({ L: 2, p: 1 });
  });
});

describe("codec", () => {
  it("round-trips a base and reads one part slice by range", async () => {
    const store = createMemoryStore();
    const rows = new Map([["0xab", [5n, 0n]], ["plain-key", [123456789012345678901234n, 7n]]]);
    const header = { table: "t", fields: 2, keyVersion: 1, bucket: 3, layout: { L: 2, p: 0 }, day: 4, part: 1 };
    const base = decodeBase(encodeBase({ header, rows }), { table: "t", bucket: 3, day: 4, part: 1 });
    expect(base.header.codec).toBe(CODEC_VERSION);
    expect([...base.rows]).toEqual([...rows]);
    const slices = new Map([[0, [{ key: "a", old: [0n, 0n], new: [1n, 0n] }]], [2, [{ key: "b", old: [2n, 0n], new: [0n, 0n] }]]]);
    const ref = await store.put(encodePart({ header: { table: "t", fields: 2, keyVersion: 1, day: 4, part: 1, layout: { L: 2, p: 0 } }, slices }));
    const ph = await readPartHeader(store, ref, { table: "t", bucket: 2, day: 4, part: 1 });
    expect(await readPartSlice(store, ref, ph, 2, { table: "t", bucket: 2, day: 4, part: 1 })).toEqual(slices.get(2));
    expect(await readPartSlice(store, ref, ph, 1, { table: "t", bucket: 1, day: 4, part: 1 })).toEqual([]);
  });
});

describe("item stores", () => {
  for (const [name, make] of [
    ["memory", () => createMemoryStore()],
    ["folder", () => createFolderStore(fs.mkdtempSync(path.join(os.tmpdir(), "itemstore-")))],
  ]) {
    it(`${name}: put, get, getRange, has, delete, list`, async () => {
      const s = make();
      const ref = await s.put(Buffer.from("hello world"));
      expect(await s.has(ref)).toBe(true);
      expect((await s.get(ref)).toString()).toBe("hello world");
      expect((await s.getRange(ref, 6, 5)).toString()).toBe("world");
      expect(await s.list()).toEqual([ref]);
      await s.delete(ref);
      expect(await s.has(ref)).toBe(false);
      await expect(s.get(ref)).rejects.toThrow(/missing item/);
    });
  }
});
