import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADER_FIRST_READ, PREFIX } from "./pack.js";
import { packName } from "./packNames.js";
import { createWorld, dayPlus, publishedOf, spyBlobs } from "./adoptionKit.js";
import { LANE_LISTING_REQUESTS, adoptLane } from "./adoptionLane.js";

const KIND = "holders";
const TAG = "data-live-2";
const D0 = "2026-11-10";
const HEADER_READ = PREFIX + HEADER_FIRST_READ;
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());

const slugsOf = (n) => Array.from({ length: n }, (_, i) => `coin-${i}`);
const lane = (coins, over = {}) => adoptLane({ blobs: w.blobs, ...w.listing, liveTag: TAG, kind: KIND, coins: coins.map((slug) => ({ slug, main: null })), ...over });

// n coins in packs of `perPack`, `days` days, each coin chained to its own yesterday.
async function history({ coins, perPack, days, bulk = 0 }) {
  let parents = {};
  for (let n = 1; n <= days; n++) {
    const next = {};
    for (let first = 0, lane_ = 0; first < coins.length; first += perPack, lane_++) {
      const group = coins.slice(first, first + perPack);
      const pack = await w.writePack({ day: dayPlus(D0, n), run: 100 + n, lane: lane_, release: TAG, bulk, coins: group.map((slug) => ({ slug, parent: parents[slug] })) });
      Object.assign(next, pack.coins);
    }
    parents = next;
  }
  return parents;
}

describe("the listing is made once per lane, however many coins it has", () => {
  it("1 coin and 16 coins: the same two listing calls and the same requests", async () => {
    const slugs = slugsOf(16);
    await history({ coins: slugs, perPack: 16, days: 2 });
    const one = await lane(slugs.slice(0, 1));
    expect(w.calls.listRelease).toBe(2);
    expect(one.listing).toMatchObject({ requests: 2, tags: [TAG, "data-live-1"], overBudget: false });
    w.calls.listRelease = 0;
    const sixteen = await lane(slugs);
    expect(w.calls.listRelease).toBe(2);
    expect(sixteen.listing).toEqual(one.listing);
  });

  it("a full pair of releases (900 assets each) costs 18 requests in the model of the design, for 1 or 16 coins", async () => {
    const full = async (tag) => ({
      entries: Array.from({ length: 900 }, (_, i) => {
        const name = packName({ cls: "live", kind: "ledger", day: D0, run: i + 1, attempt: 1, lane: 0, flush: 0 });
        return { name, size: 1000, createdAt: "2026-11-10T00:00:00Z", release: tag, state: "uploaded", loc: `${tag}/${name}` };
      }),
      requests: 9,
    });
    const spy = spyBlobs(w.blobs);
    for (const n of [1, 16]) {
      let calls = 0;
      const out = await adoptLane({ blobs: spy.blobs, listRelease: (tag) => { calls++; return full(tag); }, existingReleases: w.existingReleases, now: w.now, liveTag: TAG, kind: KIND, coins: slugsOf(n).map((slug) => ({ slug, main: null })) });
      expect(calls).toBe(2);
      expect(out.listing).toMatchObject({ requests: LANE_LISTING_REQUESTS, budget: 18, overBudget: false, assets: 1800 });
      expect(Object.keys(out.coins)).toHaveLength(n);
    }
    expect(spy.log).toEqual([]); // 1,800 packs of another kind: not one read
  });
});

describe("header reads: by range, once per pack per lane", () => {
  it("16 coins in one pack a day for 3 days: 3 header reads, not 48; one coin alone also reads 3", async () => {
    const slugs = slugsOf(16);
    await history({ coins: slugs, perPack: 16, days: 3 });
    const spy = spyBlobs(w.blobs);
    const sixteen = await lane(slugs, { blobs: spy.blobs });
    expect(sixteen.reads.headerReads).toBe(3);
    const one = await lane(slugs.slice(0, 1));
    expect(one.reads.headerReads).toBe(3);
    expect(sixteen.reads).toMatchObject({ headerReads: 3, bundleReads: 96, itemReads: 144 });
    expect(one.reads).toMatchObject({ headerReads: 3, bundleReads: 6, itemReads: 9 });
  });

  it("header reads grow with the packs, so with N/16: 32 coins in 2 packs a day read 6", async () => {
    const slugs = slugsOf(32);
    await history({ coins: slugs, perPack: 16, days: 3 });
    expect((await lane(slugs)).reads.headerReads).toBe(6);
  });

  it("a header is read by range: the first read is the prefix and 64 KiB, never the pack", async () => {
    await history({ coins: slugsOf(3), perPack: 3, days: 2, bulk: 100_000 });
    const spy = spyBlobs(w.blobs);
    await lane(slugsOf(3), { blobs: spy.blobs });
    const first = spy.log.filter((e) => e.op === "range" && e.off === 0);
    expect(first.length).toBeGreaterThan(0);
    for (const e of first) {
      const pack = w.packs.find((p) => p.loc === e.loc);
      expect(pack.size).toBeGreaterThan(HEADER_READ);
      expect(e.len).toBe(HEADER_READ);
    }
  });
});

describe("nothing reads a whole pack except the verified items of the adopted chain", () => {
  it("every range read is a header, a candidate's bundle item, or an item an adopted bundle names; a dead-end branch's items are never read", async () => {
    const slug = "coin-0";
    const m = await w.one({ slug, day: D0, run: 100, release: "data-live-1", bulk: 100_000 });
    const mk = (n, parent, run, laneNo) => w.one({ slug, day: dayPlus(D0, n), run, lane: laneNo, parent, release: TAG, bulk: 100_000 });
    const a1 = await mk(1, m, 101, 0);
    const a2 = await mk(2, a1, 102, 0);
    const a3 = await mk(3, a2, 103, 0);
    const dead = await mk(1, m, 150, 1);
    const deadChild = await mk(2, dead, 151, 1);
    const spy = spyBlobs(w.blobs);
    const out = await adoptLane({ blobs: spy.blobs, ...w.listing, liveTag: TAG, kind: KIND, coins: [{ slug, main: publishedOf(m) }] });
    expect(out.coins[slug].chain).toEqual([a1, a2, a3].map((r) => r.entry));

    const where = (rec, it) => `${rec.packInfo.loc}:${rec.packInfo.bodyStart + it.off}+${it.len}`;
    const allowed = new Set();
    for (const r of [a1, a2, a3, dead, deadChild]) allowed.add(where(r, r.items.bundle));
    for (const [r, parent] of [[a1, m], [a2, a1], [a3, a2]]) {
      allowed.add(where(r, r.items.a));
      allowed.add(where(r, r.items.base));
      allowed.add(where(parent, parent.items.base));
    }
    const forbidden = [dead, deadChild].flatMap((r) => [where(r, r.items.a), where(r, r.items.base)]);
    for (const e of spy.log.filter((x) => x.op === "range")) {
      const pack = w.packs.find((p) => p.loc === e.loc);
      expect(e.len, `${e.loc} ${e.off}+${e.len} is a whole pack`).toBeLessThan(pack.size);
      const isHeader = e.off === 0 && e.len === Math.min(pack.size, HEADER_READ);
      expect(isHeader || allowed.has(`${e.loc}:${e.off}+${e.len}`), `${e.loc} ${e.off}+${e.len}`).toBe(true);
      expect(forbidden).not.toContain(`${e.loc}:${e.off}+${e.len}`);
    }
    expect(spy.log.filter((e) => e.op === "stat").length).toBeGreaterThan(0);
  });
});

describe("the number of requests does not depend on the size of the data", () => {
  it("the same history with items of 0 and of 100,000 bytes: equal request and read counts, more bytes", async () => {
    const counts = [];
    for (const bulk of [0, 100_000]) {
      w.cleanup();
      w = createWorld();
      await history({ coins: slugsOf(4), perPack: 4, days: 3, bulk });
      const out = await lane(slugsOf(4));
      const { bytes, ...requests } = out.reads;
      counts.push({ requests, bytes, listing: out.listing.requests });
    }
    expect(counts[1].requests).toEqual(counts[0].requests);
    expect(counts[1].listing).toBe(counts[0].listing);
    expect(counts[1].bytes).toBeGreaterThan(counts[0].bytes);
  });
});
