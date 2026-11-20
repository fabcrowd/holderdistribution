// Fix round for the plumbing slice (review A3c): a coin list that cannot be overridden, a hard coin
// limit, bounded memory, a lost pack that fails its coins, size edges, and pack names that cannot
// collide between lanes.
import { afterAll, describe, expect, it } from "vitest";
import { createPackItemStore, PackLostError, PackRowConflictError } from "./packItemStore.js";
import { createLane } from "./packLane.js";
import { PackItemTooLargeError } from "./packItemInfo.js";
import { createPackWriter, openPack, PackHeaderMetaError, PACK_MAX_ITEM_BYTES } from "./pack.js";
import { packName, parsePackName } from "./packNames.js";
import { buildBundle, writeBundle } from "./bundle.js";
import { BundleBuildError } from "./errors.js";
import { coinsFromHeader, headerCounter } from "./sweepHeaders.js";
import { nextUsage } from "./usage.js";
import { StoreUploadError } from "./blobStore.js";
import { folderEnv, releaseEnv, runOf, writeCoins } from "./recordKit.js";

const envs = [];
const track = (e) => { envs.push(e); return e; };
afterAll(() => envs.forEach((e) => e.cleanup()));
const COIN = (i) => `example-${String(i).padStart(2, "0")}`;
const names = (lane = 0, cls = "live") => (flush) => packName({ cls, kind: "holders", day: "2026-11-18", run: 8, attempt: 1, lane, flush });
const headerOf = async (blobs, row) => (await openPack({ name: row.loc, size: row.size, readRange: (o, l) => blobs.readRange(row.loc, o, l) })).header;
const failing = (env, on) => { let n = 0; return { ...env.blobs, upload: async (...a) => { if (++n === on) throw new StoreUploadError("injected: upload refused"); return env.blobs.upload(...a); } }; };

describe("the coin list cannot be overridden (P1)", () => {
  it.each(["slugs", "items", "bodySize", "schema"])("a store whose meta carries %s fails at close with a named error and uploads nothing", async (key) => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(0), requireCoin: true, meta: { [key]: key === "slugs" ? [COIN(1)] : 1 } });
    await s.forCoin(COIN(1)).put(Buffer.from("1"));
    await s.forCoin(COIN(2)).put(Buffer.from("2"));
    const err = await s.close().catch((e) => e);
    expect(err).toBeInstanceOf(PackHeaderMetaError);
    expect(err.message).toContain(`"${key}"`);
    expect(await env.blobs.list("live")).toEqual([]);
  });

  it("the writer refuses it too, and a meta without those keys gives the computed list", async () => {
    const w = createPackWriter({ meta: { slugs: ["aa"] } });
    await w.add(Buffer.from("x"), { slug: "bb" });
    await expect(w.finish()).rejects.toThrow(PackHeaderMetaError);
    const ok = createPackWriter({ meta: { class: "live" } });
    await ok.add(Buffer.from("x"), { slug: "bb" });
    expect((await ok.finish()).header.slugs).toEqual(["bb"]);
  });
});

describe("the coin limit is hard (P2)", () => {
  it("five coins put before any endCoin make packs of at most two coins, in order", async () => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(1), coinLimit: 2, requireCoin: true });
    for (let i = 1; i <= 5; i++) await s.forCoin(COIN(i)).put(Buffer.from(`c${i}`));
    const { packs } = await s.close();
    const lists = [];
    for (const row of packs) lists.push((await headerOf(env.fresh(), row)).slugs);
    expect(lists).toEqual([[COIN(1), COIN(2)], [COIN(3), COIN(4)], [COIN(5)]]);
  });

  it("interleaved views never exceed the limit, and a coin that continues after a flush is listed in both packs", async () => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(2), coinLimit: 2, requireCoin: true });
    const [a, b, c] = [1, 2, 3].map((i) => s.forCoin(COIN(i)));
    for (const v of [a, b, a, c, b, c, a]) await v.put(Buffer.from("x"));
    const { packs } = await s.close();
    for (const row of packs) expect((await headerOf(env.fresh(), row)).slugs.length).toBeLessThanOrEqual(2);
    expect(packs.reduce((n, r) => n + r.items, 0)).toBe(7);
    const heads = await Promise.all(packs.map((r) => headerOf(env.fresh(), r)));
    expect(heads.filter((h) => h.slugs.includes(COIN(1))).length).toBeGreaterThan(1);
  });
});

describe("memory and cost of the coin lists (P4)", () => {
  it("appending a ref does not copy the coin's list: 30,000 puts cost about three times 10,000", async () => {
    const env = track(folderEnv());
    const time = async (n, lane) => {
      const v = createPackItemStore({ blobs: env.blobs, nameFor: names(lane), requireCoin: true, targetBytes: 1e12 }).forCoin("big");
      const t = performance.now();
      for (let i = 0; i < n; i++) await v.put(Buffer.from("x"));
      return performance.now() - t;
    };
    await time(2000, 3); // warm up
    const small = await time(10_000, 4);
    const big = await time(30_000, 5);
    expect(big / small, `10,000 took ${small | 0} ms, 30,000 took ${big | 0} ms`).toBeLessThan(6);
  }, 60_000);

  it("a lane store keeps nothing for a finished coin: 200 coins leave no tracked coin and no ref", async () => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(6), requireCoin: true });
    for (let i = 1; i <= 200; i++) {
      const v = s.forCoin(COIN(i));
      for (let n = 0; n < 3; n++) await v.put(Buffer.from(`${i}-${n}`));
      expect((await v.list()).length).toBe(3);
      await s.endCoin(COIN(i));
      expect(await v.list()).toEqual([]);
    }
    const stats = s.stats();
    expect(stats).toMatchObject({ trackedCoins: 0, trackedRefs: 0, lostCoins: 0 });
    expect(stats.openItems).toBeLessThanOrEqual(16 * 3);
    expect(await s.list()).toEqual([]);
    expect(s.rows()).toHaveLength(12); // one row per uploaded pack (the lane needs them for bundles), not per coin
  });
});

describe("a lost pack fails its coins and leaves nothing behind (P3)", () => {
  it("every coin with an item in the lost pack throws PackLostError on put, list and has; list() never returns a lost ref", async () => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: failing(env, 1), nameFor: names(7), coinLimit: 2, requireCoin: true });
    const a = s.forCoin(COIN(1));
    const b = s.forCoin(COIN(2));
    const ra = await a.put(Buffer.from("a"));
    await b.put(Buffer.from("b"));
    await expect(s.endCoin(COIN(2))).rejects.toBeInstanceOf(StoreUploadError);
    for (const v of [a, b]) {
      await expect(v.put(Buffer.from("again"))).rejects.toBeInstanceOf(PackLostError);
      await expect(v.list()).rejects.toBeInstanceOf(PackLostError);
      await expect(v.has(ra)).rejects.toBeInstanceOf(PackLostError);
    }
    expect(s.lostCoins()).toEqual([COIN(1), COIN(2)]);
    expect(await s.list()).toEqual([]);
    expect(s.rows()).toEqual([]);
    const c = s.forCoin(COIN(3)); // a coin that was not in the lost pack goes on, into the next pack
    expect(await c.put(Buffer.from("c"))).toMatch(/f1\.hdb#0$/);
    expect(await c.list()).toHaveLength(1);
  });

  it("the plain store's list() drops the refs of a lost pack too", async () => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: failing(env, 1), nameFor: names(8), coinLimit: 1 });
    await s.put(Buffer.from("a"));
    await expect(s.close()).rejects.toBeInstanceOf(StoreUploadError);
    expect(await s.list()).toEqual([]);
  });

  it("a lane fails the coin in every store of the lane", async () => {
    const env = track(folderEnv());
    const lane = createLane({ blobs: failing(env, 1), nameFor: ({ cls, flush }) => packName({ cls, kind: "holders", day: "2026-11-18", run: 9, attempt: 1, lane: 0, flush }), stores: [{ name: "keep", cls: "keep" }, { name: "live", cls: "live" }], coinLimit: 1 });
    const views = lane.forCoin(COIN(1));
    await views.keep.put(Buffer.from("k"));
    await expect(lane.endCoin(COIN(1), ["keep"])).rejects.toBeInstanceOf(StoreUploadError);
    await expect(views.live.put(Buffer.from("l"))).rejects.toBeInstanceOf(PackLostError);
    expect(lane.lostCoins()).toEqual([COIN(1)]);
  });

  it("writeBundle refuses a ref with no row before it puts anything, so no stray bundle item is left", async () => {
    const env = track(folderEnv());
    const items = createPackItemStore({ blobs: failing(env, 1), nameFor: names(9), requireCoin: true, coinLimit: 1 });
    const lost = await items.forCoin(COIN(1)).put(Buffer.from("a"));
    await expect(items.endCoin(COIN(1))).rejects.toBeInstanceOf(StoreUploadError);
    const bundles = createPackItemStore({ blobs: env.blobs, nameFor: names(10), requireCoin: true });
    const bundle = buildBundle({
      slug: COIN(1), kind: "holders", day: "2026-11-18", run: runOf(8), parent: null, usage: nextUsage({ parent: null, day: "2026-11-18", used: {} }),
      blobs: { "a.json": lost }, tables: {}, stateIndex: null, packs: [],
    });
    await expect(writeBundle(bundles.forCoin(COIN(1)), bundle)).rejects.toBeInstanceOf(BundleBuildError);
    expect(bundles.stats()).toMatchObject({ openItems: 0, trackedRefs: 0 });
    expect((await bundles.close()).packs).toEqual([]);
    expect(await env.blobs.list("live")).toEqual([]);
  });
});

describe("size edges (P5)", () => {
  it("a pack never goes over the byte target because of its last item; a single item over the target sits alone", async () => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(11), requireCoin: true, targetBytes: 100 });
    const v = s.forCoin(COIN(1));
    for (let i = 0; i < 3; i++) await v.put(Buffer.alloc(60, i));
    await v.put(Buffer.alloc(150, 9));
    await v.put(Buffer.alloc(10, 1));
    const { packs } = await s.close();
    const bodies = [];
    for (const row of packs) bodies.push((await headerOf(env.fresh(), row)).bodySize);
    expect(bodies).toEqual([60, 60, 60, 150, 10]);
    for (const b of bodies.filter((n) => n !== 150)) expect(b).toBeLessThanOrEqual(100);
  });

  it("an item above the hard limit is a named error and changes nothing; the limit is below GitHub's 2 GiB with a margin", async () => {
    expect(PACK_MAX_ITEM_BYTES).toBeLessThanOrEqual(2 * 1024 ** 3 - 64 * 1024 ** 2);
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(12), requireCoin: true, maxItemBytes: 200 });
    const v = s.forCoin(COIN(1));
    await v.put(Buffer.alloc(200));
    const err = await v.put(Buffer.alloc(201)).catch((e) => e);
    expect(err).toBeInstanceOf(PackItemTooLargeError);
    expect(err.message).toMatch(/201 bytes.*200/);
    expect(s.stats().openItems).toBe(1);
  });
});

describe("addRows", () => {
  it("never replaces a stored location: a row with another location or size is a named error", async () => {
    const env = track(folderEnv());
    const s = createPackItemStore({ blobs: env.blobs, nameFor: names(13), requireCoin: true });
    await s.forCoin(COIN(1)).put(Buffer.from("a"));
    const [row] = (await s.close()).packs;
    expect(() => s.addRows([row])).not.toThrow();
    expect(() => s.addRows([{ ...row, loc: "data-live-9/x" }])).toThrow(PackRowConflictError);
    expect(() => s.addRows([{ ...row, size: row.size + 1 }])).toThrow(PackRowConflictError);
  });
});

describe.each([["folder", folderEnv], ["release", releaseEnv]])("pack names of 16 lanes from the record kit on the %s backend", (_, makeEnv) => {
  it("never collide: lane numbers 0 to 15, the bundle store and the item store of class live share one flush counter", async () => {
    const env = track(makeEnv());
    const all = new Set();
    for (let lane = 0; lane < 16; lane++) {
      const built = await writeCoins({ env, specs: [{ slug: COIN(lane * 2 + 1) }, { slug: COIN(lane * 2 + 2) }] });
      for (const b of built) {
        for (const r of [...b.rows, ...b.ownRows]) all.add(r.name);
      }
    }
    const lanes = new Set([...all].map((n) => parsePackName(n).lane));
    expect([...lanes].sort((x, y) => x - y)).toEqual(Array.from({ length: 16 }, (_x, i) => i));
    expect((await env.blobs.list("live")).length).toBe(all.size);
    for (const lane of lanes) {
      const flushes = [...all].map(parsePackName).filter((p) => p.lane === lane).map((p) => p.flush).sort((x, y) => x - y);
      expect(flushes).toEqual(flushes.map((_x, i) => i)); // 0, 1, 2 ...: one counter for both stores
    }
  });

  it("createLane: stores of one class share a counter, stores of different classes count apart", async () => {
    const env = track(makeEnv());
    const lane = createLane({
      blobs: env.blobs, nameFor: ({ cls, flush }) => packName({ cls, kind: "holders", day: "2026-11-18", run: 3, attempt: 1, lane: 4, flush }),
      stores: [{ name: "items", cls: "live" }, { name: "bundles", cls: "live" }, { name: "keep", cls: "keep" }], coinLimit: 1,
    });
    for (let i = 1; i <= 2; i++) {
      const v = lane.forCoin(COIN(i));
      await v.items.put(Buffer.from(`i${i}`));
      await v.bundles.put(Buffer.from(`b${i}`));
      await v.keep.put(Buffer.from(`k${i}`));
      await lane.endCoin(COIN(i));
    }
    const { packs } = await lane.close();
    const flushesOf = (cls) => packs.map((r) => parsePackName(r.name)).filter((p) => p.cls === cls).map((p) => p.flush).sort((x, y) => x - y);
    expect(flushesOf("live")).toEqual([0, 1, 2, 3]);
    expect(flushesOf("keep")).toEqual([0, 1]);
    expect(await coinsFromHeader({ blobs: env.fresh(), entry: packs[0], counter: headerCounter() })).toHaveProperty("coins");
  });
});
