import { describe, expect, it } from "vitest";
import { bucketCount } from "./buckets.js";
import { Harness, changesOf, keysIn, val } from "./storeTestKit.js";
import { writePart, writePartBuckets } from "./tableWrite.js";

// A part written bucket by bucket holds one bucket's change rows at a time (counted through the `trace`
// hook, not process memory) and equals the part writePart(Map) makes from the same changes.
const LAYOUT = { L: 3, p: 0 };
const PER_BUCKET = 5;

async function started() {
  const h = new Harness({ rowsPerBucket: 1000 });
  const keys = Array.from({ length: bucketCount(LAYOUT) }, (_, b) => keysIn(b, LAYOUT, 9, `k${b}x`));
  const initial = {};
  for (const list of keys) for (const k of list) initial[k] = 10;
  await h.initial(1, LAYOUT, initial);
  return { h, keys };
}

describe("writePartBuckets", () => {
  it("peak change rows held equals one bucket's change rows, and the part equals writePart's", async () => {
    const { h, keys } = await started();
    const buckets = keys.map((list, bucket) => ({ bucket, changes: changesOf(Object.fromEntries(list.slice(0, PER_BUCKET).map((k, i) => [k, 20 + i]))) }));
    const held = [];
    const res = await writePartBuckets({ store: h.store, index: h.index, day: 2, buckets, trace: (t) => held.push(t.held) });
    expect(held).toHaveLength(bucketCount(LAYOUT));
    expect(Math.max(...held)).toBe(PER_BUCKET);
    expect(res.rows).toBe(PER_BUCKET * bucketCount(LAYOUT));
    expect(res.rows).toBeGreaterThan(Math.max(...held));
    const all = new Map(buckets.flatMap((b) => [...b.changes]));
    const via = await writePart({ store: h.store, index: h.index, day: 2, changes: all });
    expect(via.ref).toBe(res.ref);
    expect(via.index).toEqual(res.index);
    h.index = res.index;
    h.model.set(2, new Map([...h.model.get(1)].map(([k, v]) => [k, all.has(k) ? all.get(k).join("/") : v])));
    await h.verifyAll();
  });

  it("an async iterator is accepted, a bucket given twice and a key in the wrong bucket are refused", async () => {
    const { h, keys } = await started();
    async function* one() {
      yield { bucket: 0, changes: new Map([[keys[0][0], val(99)]]) };
    }
    expect((await writePartBuckets({ store: h.store, index: h.index, day: 2, buckets: one() })).rows).toBe(1);
    const twice = [{ bucket: 0, changes: new Map() }, { bucket: 0, changes: new Map() }];
    await expect(writePartBuckets({ store: h.store, index: h.index, day: 2, buckets: twice })).rejects.toThrow("given twice");
    await expect(writePartBuckets({ store: h.store, index: h.index, day: 2, buckets: [{ bucket: 1, changes: new Map([[keys[0][0], val(1)]]) }] })).rejects.toThrow("not in bucket 1");
  });

  it("replace: true removes a current key the new bucket content lacks", async () => {
    const { h, keys } = await started();
    const keep = keys[2].slice(0, 6);
    const res = await writePartBuckets({ store: h.store, index: h.index, day: 2, buckets: [{ bucket: 2, replace: true, changes: new Map(keep.map((k) => [k, val(10)])) }] });
    expect(res.rows).toBe(3);
    expect(res.index.buckets[2].count).toBe(6);
  });
});
