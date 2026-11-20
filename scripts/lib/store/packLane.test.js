// Whose item is whose (design 2.1 section 7.2 and 9.1 end steps 5 and 6): the item
// information a put records, the coin list of a header, the per-coin view, the coin
// boundary that flushes, and the rows of packs uploaded before close(). Folder and release
// backends run the same cases.
import { afterAll, describe, expect, it } from "vitest";
import { createPackItemStore, PackLostError } from "./packItemStore.js";
import { ITEM_TYPES, PackItemInfoError, PackCoinRequiredError } from "./packItemInfo.js";
import { openPack, PACK_COIN_LIMIT } from "./pack.js";
import { packName } from "./packNames.js";
import { coinsFromHeader, headerCounter } from "./sweepHeaders.js";
import { StoreUploadError } from "./blobStore.js";
import { folderEnv, releaseEnv } from "./recordKit.js";
import { rng } from "./storeTestKit.js";

const envs = [];
const track = (e) => { envs.push(e); return e; };
afterAll(() => envs.forEach((e) => e.cleanup()));

const COIN = (i) => `example-${String(i).padStart(2, "0")}`;
const names = (lane = 0, cls = "live") => (flush) => packName({ cls, kind: "holders", day: "2026-11-18", run: 7, attempt: 1, lane, flush });
function bytesOf(n, seed) {
  const next = rng(seed);
  return Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256)));
}
const headerOf = async (blobs, row) => (await openPack({ name: row.loc, size: row.size, readRange: (o, l) => blobs.readRange(row.loc, o, l) })).header;
const open = (env, extra = {}) => createPackItemStore({ blobs: env.blobs, nameFor: names(), requireCoin: true, ...extra });

describe("item information is validated (named errors)", () => {
  const env = track(folderEnv());
  const bad = [
    ["a type outside the closed list", { type: "thing", slug: COIN(1) }, /type "thing"/],
    ["a slug that is not a slug", { type: "blob", slug: "Example" }, /slug/],
    ["a slug with a path separator", { type: "blob", slug: "../x" }, /slug/],
    ["a negative bucket", { type: "base", slug: COIN(1), bucket: -1 }, /bucket/],
    ["a bucket that is not a whole number", { type: "base", slug: COIN(1), bucket: 1.5 }, /bucket/],
    ["a day that is not a day", { type: "part", slug: COIN(1), day: "2026-02-31" }, /day/],
    ["an empty path", { type: "blob", slug: COIN(1), path: "" }, /path/],
    ["a table of the wrong type", { type: "base", slug: COIN(1), table: 4 }, /table/],
    ["a field the header does not take from a caller", { type: "blob", slug: COIN(1), off: 3 }, /unknown field "off"/],
    ["the encoding, which the store decides", { type: "blob", slug: COIN(1), enc: "br" }, /unknown field "enc"/],
    ["information that is not an object", "blob", /must be an object/],
  ];
  it.each(bad)("%s", async (_, info, why) => {
    const s = open(env);
    const err = await s.put(Buffer.from("x"), info).catch((e) => e);
    expect(err).toBeInstanceOf(PackItemInfoError);
    expect(err.message).toMatch(why);
    expect(err.message).toMatch(/pack item store/);
  });

  it("every type of the closed list is accepted, and the list is the one the design's kinds need", async () => {
    expect(ITEM_TYPES).toEqual(["item", "bundle", "blob", "base", "part", "index", "slice", "history", "list", "day"]);
    const s = open(env, { nameFor: names(31) });
    for (const type of ITEM_TYPES) await s.put(Buffer.from(type), { type, slug: COIN(1) });
    expect((await s.close()).packs[0].items).toBe(ITEM_TYPES.length);
  });

  it("does not change the information it is given", async () => {
    const info = Object.freeze({ type: "blob", slug: COIN(1), path: "a.json" });
    await expect(open(env, { nameFor: names(32) }).put(Buffer.from("x"), info)).resolves.toMatch(/#0$/);
  });
});

describe.each([["folder", folderEnv], ["release", releaseEnv]])("packs on the %s backend", (_, makeEnv) => {
  it("records the item information in the header and lists the coins of its items, with no list passed in", async () => {
    const env = track(makeEnv());
    const s = open(env);
    await s.put(bytesOf(300, 1), { type: "blob", slug: COIN(2), path: "data/x.json", day: "2026-11-18", madeAt: "2026-11-18T01:00:00Z" });
    await s.put(bytesOf(300, 2), { type: "base", slug: COIN(1), table: "acct", bucket: 3 });
    await s.put(bytesOf(300, 3), { type: "blob", slug: COIN(2), path: "data/y.json" });
    const { packs: [row] } = await s.close();
    const h = await headerOf(env.fresh(), row);
    expect(h.slugs).toEqual([COIN(1), COIN(2)]);
    expect(h.items.map((i) => [i.id, i.type, i.slug, i.path, i.table, i.bucket, i.day, i.madeAt])).toEqual([
      [0, "blob", COIN(2), "data/x.json", null, null, "2026-11-18", "2026-11-18T01:00:00Z"],
      [1, "base", COIN(1), null, "acct", 3, null, null],
      [2, "blob", COIN(2), "data/y.json", null, null, null, null],
    ]);
    const read = await coinsFromHeader({ blobs: env.fresh(), entry: row, counter: headerCounter() });
    expect(read).toEqual({ coins: [COIN(1), COIN(2)] });
  });

  it("a plain put keeps working for the table code: type item, no coin, and no coin list in the header", async () => {
    const env = track(makeEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(1) });
    await s.put(Buffer.from("plain"));
    await s.put(Buffer.from("labelled"), { type: "blob", slug: COIN(1) });
    const { packs: [row] } = await s.close();
    const h = await headerOf(env.fresh(), row);
    expect(h.items.map((i) => [i.type, i.slug])).toEqual([["item", null], ["blob", COIN(1)]]);
    expect("slugs" in h).toBe(false); // a list that omitted the unlabelled item would let the sweep drop it
    const read = await coinsFromHeader({ blobs: env.fresh(), entry: row, counter: headerCounter() });
    expect(read.failure).toBe("no-coin-list");
  });

  it("the lane path refuses a write with no coin, naming the rule", async () => {
    const env = track(makeEnv());
    const s = open(env, { nameFor: names(2) });
    for (const args of [[Buffer.from("x")], [Buffer.from("x"), {}], [Buffer.from("x"), { type: "blob" }]]) {
      const err = await s.put(...args).catch((e) => e);
      expect(err).toBeInstanceOf(PackCoinRequiredError);
      expect(err.message).toMatch(/every item .* a coin/);
    }
    expect(s.rows()).toEqual([]);
    expect(await s.list()).toEqual([]);
  });

  it("forCoin gives the item-store interface whose writes carry the coin, and the table code never names it", async () => {
    const env = track(makeEnv());
    const s = open(env, { nameFor: names(3) });
    const a = s.forCoin(COIN(1));
    const b = s.forCoin(COIN(2));
    expect(Object.keys(a).sort()).toEqual(["delete", "get", "getRange", "has", "list", "put"]);
    const ra = await a.put(bytesOf(100, 4));
    const rb = await b.put(bytesOf(100, 5), { type: "part", bucket: 2 });
    expect(await a.list()).toEqual([ra]);
    expect(await b.list()).toEqual([rb]);
    expect((await a.get(ra)).equals(bytesOf(100, 4))).toBe(true);
    expect((await b.getRange(rb, 10, 5)).equals(bytesOf(100, 5).subarray(10, 15))).toBe(true);
    expect(await a.has(rb)).toBe(true); // reads are by reference, not by coin
    const err = await a.put(Buffer.from("x"), { type: "blob", slug: COIN(2) }).catch((e) => e);
    expect(err).toBeInstanceOf(PackItemInfoError);
    expect(err.message).toMatch(/example-01.*example-02/);
    expect(() => s.forCoin("Not A Slug")).toThrow(PackItemInfoError);
    const { packs: [row] } = await s.close();
    const h = await headerOf(env.fresh(), row);
    expect(h.items.map((i) => [i.type, i.slug, i.bucket])).toEqual([["item", COIN(1), null], ["part", COIN(2), 2]]);
    expect(h.slugs).toEqual([COIN(1), COIN(2)]);
  });

  it("endCoin flushes at the coin limit and not before; the limit defaults to the design's 16", async () => {
    expect(PACK_COIN_LIMIT).toBe(16);
    const env = track(makeEnv());
    const s = open(env, { nameFor: names(4), coinLimit: 3 });
    for (let i = 1; i <= 2; i++) {
      await s.forCoin(COIN(i)).put(bytesOf(200, i));
      expect(await s.endCoin(COIN(i))).toEqual({ flushed: false });
      expect(s.rows()).toEqual([]);
    }
    await s.forCoin(COIN(3)).put(bytesOf(200, 3));
    expect(await s.endCoin(COIN(3))).toEqual({ flushed: true });
    const rows = s.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: names(4)(0), items: 3 });
    expect(s.stats().openItems).toBe(0);
    await s.forCoin(COIN(4)).put(bytesOf(200, 4));
    expect(await s.endCoin(COIN(4))).toEqual({ flushed: false });
    expect((await s.close()).packs.map((r) => r.items)).toEqual([3, 1]); // the lane's last coin closes
  });

  it("a coin with no item in this store does not count toward its limit", async () => {
    const env = track(makeEnv());
    const s = open(env, { nameFor: names(5), coinLimit: 2 });
    await s.forCoin(COIN(1)).put(bytesOf(50, 1));
    expect(await s.endCoin(COIN(1))).toEqual({ flushed: false });
    expect(await s.endCoin(COIN(2))).toEqual({ flushed: false });
    expect(await s.endCoin(COIN(3))).toEqual({ flushed: false });
    expect(s.rows()).toEqual([]);
  });

  it("a coin's items may span two packs at the byte target; both headers list it and the rows resolve every item", async () => {
    const env = track(makeEnv());
    const s = open(env, { nameFor: names(6), targetBytes: 1000 });
    const mine = s.forCoin(COIN(1));
    const refs = [];
    for (let i = 0; i < 3; i++) refs.push(await mine.put(bytesOf(600, 10 + i)));
    await s.endCoin(COIN(1));
    const { packs } = await s.close();
    expect(packs.map((r) => r.items)).toEqual([1, 1, 1]); // an item that would cross the target flushes first (review P5)
    const heads = await Promise.all(packs.map((r) => headerOf(env.fresh(), r)));
    expect(heads.map((h) => h.slugs)).toEqual([[COIN(1)], [COIN(1)], [COIN(1)]]);
    const reader = createPackItemStore({ blobs: env.fresh(), nameFor: names(99), packs });
    for (const [i, ref] of refs.entries()) expect((await reader.get(ref)).equals(bytesOf(600, 10 + i))).toBe(true);
    expect(refs.map((r) => r.slice(0, r.lastIndexOf("#"))).filter((n, i, a) => a.indexOf(n) === i)).toHaveLength(3);
  });

  it("memory is one open pack: the open bytes stay under the target however many coins pass", async () => {
    const env = track(makeEnv());
    const s = open(env, { nameFor: names(7), targetBytes: 2000, coinLimit: 100 });
    for (let i = 1; i <= 30; i++) {
      await s.forCoin(COIN(i)).put(bytesOf(300, i));
      await s.endCoin(COIN(i));
      expect(s.stats().openBytes).toBeLessThan(2000);
    }
    expect(s.stats().uploads).toBeGreaterThan(3);
  });

  it("rows() before close: closed and uploaded packs only, as copies, each after its upload returned a location", async () => {
    const env = track(makeEnv());
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const blobs = { ...env.blobs, upload: async (...a) => { if (++calls === 1) await gate; return env.blobs.upload(...a); } };
    const s = createPackItemStore({ blobs, nameFor: names(8), requireCoin: true, coinLimit: 1 });
    await s.forCoin(COIN(1)).put(bytesOf(100, 1));
    const flushing = s.endCoin(COIN(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.rows()).toEqual([]); // the upload has not returned a location
    release();
    await flushing;
    const [row] = s.rows();
    expect(row).toMatchObject({ name: names(8)(0), loc: `${row.loc.split("/")[0]}/${names(8)(0)}`, items: 1 });
    expect(await env.fresh().exists(row.loc)).toBe(true);
    row.loc = "tampered";
    expect(s.rows()[0].loc).not.toBe("tampered");
    expect(Object.keys(s.rows()[0]).sort()).toEqual(["headerSha256", "items", "loc", "name", "sha256", "size"]);
  });

  it("a failed upload exposes no row, throws the named error, and loses the refs of that pack only", async () => {
    const env = track(makeEnv());
    let calls = 0;
    const blobs = { ...env.blobs, upload: async (...a) => { if (++calls === 2) throw new StoreUploadError("injected: upload refused"); return env.blobs.upload(...a); } };
    const s = createPackItemStore({ blobs, nameFor: names(9), requireCoin: true, coinLimit: 1 });
    const r1 = await s.forCoin(COIN(1)).put(bytesOf(100, 1));
    await s.endCoin(COIN(1));
    const r2 = await s.forCoin(COIN(2)).put(bytesOf(100, 2));
    const err = await s.endCoin(COIN(2)).catch((e) => e);
    expect(err).toBeInstanceOf(StoreUploadError);
    expect(err.message).toMatch(/injected/);
    expect(s.rows().map((r) => r.name)).toEqual([names(9)(0)]); // only the pack that was uploaded
    await expect(s.get(r2)).rejects.toBeInstanceOf(PackLostError);
    expect((await s.get(r1)).equals(bytesOf(100, 1))).toBe(true);
  });

  it.each([[1, 1], [16, 1], [17, 2], [40, 3]])("uploads per lane: %i coins of two small items make %i upload(s) at the default limits", async (coins, uploads) => {
    const env = track(makeEnv());
    let calls = 0;
    const blobs = { ...env.blobs, upload: (...a) => { calls++; return env.blobs.upload(...a); } };
    const s = createPackItemStore({ blobs, nameFor: names(10 + coins), requireCoin: true });
    for (let i = 1; i <= coins; i++) {
      for (let n = 0; n < 2; n++) await s.forCoin(COIN(i)).put(bytesOf(500, i * 3 + n));
      await s.endCoin(COIN(i));
    }
    await s.close();
    expect(calls).toBe(uploads);
    if (env.server) expect(env.server.counts.upload).toBe(uploads);
  });

  it("uploads per lane at the byte target: 40 coins of one 1,000-byte item at a 10,000-byte target make 4 uploads of 10 coins", async () => {
    const env = track(makeEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(60), requireCoin: true, targetBytes: 10_000 });
    for (let i = 1; i <= 40; i++) {
      await s.forCoin(COIN(i)).put(bytesOf(1000, i));
      await s.endCoin(COIN(i));
    }
    const { packs } = await s.close();
    expect(packs.map((r) => r.items)).toEqual([10, 10, 10, 10]);
    if (env.server) expect(env.server.counts.upload).toBe(4);
  });
});
