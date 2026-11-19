// The state check must catch each kind of wrong read, and name the table,
// bucket, day and part in the error.
import { describe, it, expect } from "vitest";
import { Harness, readState, val } from "./storeTestKit.js";
import { StoreCheckError, rowHash, changeRowHash, hashToHex } from "./stateCheck.js";
import { encodeBase, encodePart } from "./codec.js";

const T = 20000;

async function expectCheckError(promise) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(StoreCheckError);
  expect(err.table).toBe("acct");
  expect(Number.isInteger(err.bucket)).toBe(true);
  expect(err.day).not.toBeUndefined();
  expect(err.part).not.toBeUndefined();
  expect(err.message).toMatch(/table=acct bucket=\d+ day=\d+ part=\S+/);
  return err;
}

// R = 10: one bucket, base on day 1, no rewrite on days 2 and 3.
async function threeDays() {
  const h = new Harness({ rowsPerBucket: 10 });
  await h.night(1, { A: 5, B: 3, C: 1, D: 1, E: 1 });
  await h.night(2, { A: 7 });
  await h.night(3, { A: 8 });
  return h;
}

// A hand-made part appended to day `day` of the index, its record set to `record`.
async function appendPart(h, day, rows, record) {
  const layout = h.index.layout;
  const ref = await h.store.put(
    encodePart({
      header: { table: "acct", fields: 2, keyVersion: 1, day, part: 1, layout },
      slices: new Map([[0, rows]]),
    }),
  );
  let hash = 0n;
  for (const r of rows) hash = (hash + changeRowHash(r.key, r.old, r.new)) & ((1n << 64n) - 1n);
  const idx = structuredClone(h.index);
  idx.days.push({
    day,
    parts: [{ ref, rows: rows.length, hash: hashToHex(hash), layout, layoutAfter: layout, splits: [], checks: { 0: record }, slices: { 0: rows.length } }],
  });
  return idx;
}

describe("the state check catches", () => {
  it("a part applied to the wrong parent", async () => {
    const h = await threeDays();
    const other = new Harness({ rowsPerBucket: 10 });
    other.store = h.store;
    other.index = h.versions[0].index;
    await other.night(2, { A: 6 });
    await other.night(3, { A: 9 });
    const idx = structuredClone(h.index);
    idx.days[2] = structuredClone(other.index.days[2]); // day 3 computed on another day 2
    const err = await expectCheckError(readState(h.store, idx, 3));
    expect(err.day).toBe(3);
  }, T);

  it("a missing part", async () => {
    const h = await threeDays();
    const idx = structuredClone(h.index);
    idx.days.splice(1, 1);
    await expectCheckError(readState(h.store, idx, 3));
  }, T);

  it("a duplicated part in the forward path", async () => {
    const h = await threeDays();
    const idx = structuredClone(h.index);
    idx.days[1].parts.push(structuredClone(idx.days[1].parts[0]));
    const err = await expectCheckError(readState(h.store, idx, 2));
    expect([err.day, err.part]).toEqual([2, 2]);
  }, T);

  it("a row whose old value does not match", async () => {
    const h = await threeDays();
    const idx = await appendPart(h, 4, [{ key: "B", old: val(4), new: val(6) }], { count: 5, hash: "0" });
    const err = await expectCheckError(readState(h.store, idx, 4));
    expect([err.day, err.part]).toEqual([4, 1]);
  }, T);

  it("a key spelled two ways", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { "0xab": 5 });
    // the writer would compute this record for the canonical spelling
    const record = { count: 1, hash: hashToHex(rowHash("0xab", val(6))) };
    const idx = await appendPart(h, 2, [{ key: "0xAB", old: val(0), new: val(6) }], record);
    await expectCheckError(readState(h.store, idx, 2));
    const idx2 = await appendPart(h, 2, [{ key: "0xAB", old: val(5), new: val(6) }], record);
    await expectCheckError(readState(h.store, idx2, 2));
  }, T);

  it("one flipped byte in a base file", async () => {
    const h = await threeDays();
    const ref = h.index.buckets[0].base.ref;
    const bytes = h.store.items.get(ref);
    bytes[bytes.length - 12] ^= 0x01;
    await expectCheckError(readState(h.store, h.index, 3));
  }, T);

  it("one flipped byte in a part file", async () => {
    const h = await threeDays();
    const ref = h.index.days[1].parts[0].ref;
    const bytes = h.store.items.get(ref);
    bytes[bytes.length - 12] ^= 0x01;
    const err = await expectCheckError(readState(h.store, h.index, 2));
    expect(err.day).toBe(2);
  }, T);

  it("a base reference whose recorded hash is wrong", async () => {
    const h = await threeDays();
    const idx = structuredClone(h.index);
    idx.buckets[0].base.hash = "0000000000000001";
    const err = await expectCheckError(readState(h.store, idx, 1));
    expect([err.bucket, err.day, err.part]).toEqual([0, 1, 1]);
  }, T);

  it("two swapped values on two keys (the hash is over key and value together)", async () => {
    const h = await threeDays();
    const idx = structuredClone(h.index);
    const base = idx.buckets[0].base;
    const rows = new Map([["A", val(3)], ["B", val(5)], ["C", val(1)], ["D", val(1)], ["E", val(1)]]);
    base.ref = await h.store.put(
      encodeBase({ header: { table: "acct", fields: 2, keyVersion: 1, bucket: 0, layout: idx.layout, day: 1, part: 1 }, rows }),
    );
    await expectCheckError(readState(h.store, idx, 1));
  }, T);
});
