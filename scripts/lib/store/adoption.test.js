import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptChain } from "./acceptChain.js";
import { readBundle } from "./bundle.js";
import { AdoptionListingError, RecordShapeError } from "./errors.js";
import { AT, createWorld, dayPlus, publishedOf } from "./adoptionKit.js";
import { LANE_LISTING_REQUESTS, adoptLane, listLane } from "./adoptionLane.js";
import { StoreRateLimitError } from "./blobStore.js";
import { published } from "./manifest.js";

const SLUG = "example";
const KIND = "holders";
const TAG = "data-live-2";
const D0 = "2026-11-10";
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());

const mainRec = () => w.one({ slug: SLUG, day: D0, run: 100, release: "data-live-1" });
const lane = (coins, over = {}) => adoptLane({ blobs: w.blobs, ...w.listing, liveTag: TAG, kind: KIND, coins, ...over });
const adopt = async (main, over) => (await lane([{ slug: SLUG, main: main ? publishedOf(main) : null }], over)).coins[SLUG];
const next = (parent, n, over = {}) => w.one({ slug: SLUG, day: dayPlus(D0, n), run: 100 + n, parent, release: TAG, ...over });
async function chainOf(parent, count, over = {}) {
  const out = [];
  for (let n = 1; n <= count; n++) out.push(await next(out.at(-1) ?? parent, n, over));
  return out;
}
const accepted = (main, chain) => acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: main ? publishedOf(main) : null, chain });
const keys = (r) => r.chain.map((e) => e.bundle.ref);
const why = (r) => r.why.join("\n");

describe("what adoption keeps: the day, the state, the kind, the coin", () => {
  it("a pack dated on the main entry's day is not adopted; one dated the day after is", async () => {
    const m = await mainRec();
    const same = await w.one({ slug: SLUG, day: D0, run: 101, parent: m, release: TAG });
    let r = await adopt(m);
    expect(r.chain).toEqual([]);
    expect(r.start).toEqual({ source: "main", entry: publishedOf(m), bundle: null });
    expect(why(r)).toMatch(/dated on or before the main entry's day 2026-11-10/);
    const after = await next(m, 1);
    r = await adopt(m);
    expect(r.chain).toEqual([after.entry]);
    expect(r.chain).not.toContainEqual(same.entry);
    expect(r.start.source).toBe("adopted");
  });

  it("a pack whose state is not uploaded is ignored (a dead upload); the same pack uploaded is adopted", async () => {
    const m = await mainRec();
    const dead = await next(m, 1, { state: "starter" });
    let r = await adopt(m);
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/1 pack not uploaded \(state starter\)/);
    w.setState(dead.packInfo, "uploaded");
    r = await adopt(m);
    expect(r.chain).toEqual([dead.entry]);
  });

  it("a pack of another kind is ignored and counted; the same pack is adopted by a run of its own kind", async () => {
    const m = await mainRec();
    const ledger = await w.one({ slug: SLUG, kind: "ledger", day: dayPlus(D0, 1), run: 101, release: TAG });
    let r = await adopt(m);
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/1 pack of another kind/);
    r = (await lane([{ slug: SLUG, main: null }], { kind: "ledger" })).coins[SLUG];
    expect(r.chain).toEqual([ledger.entry]);
  });

  it("a pack that does not list the coin is skipped; a pack that lists it but holds another coin's bundle under its name is dropped", async () => {
    const m = await mainRec();
    const day = dayPlus(D0, 1);
    const both = await w.writePack({ day, run: 101, release: TAG, coins: [{ slug: SLUG, as: "beta" }, { slug: "beta" }] });
    await w.writePack({ day, run: 102, lane: 1, release: TAG, coins: [{ slug: "gamma" }] });
    const r = await adopt(m);
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/1 pack does not list example/);
    expect(why(r)).toMatch(/bundle for example belongs to another coin/);
    const beta = (await lane([{ slug: "beta", main: null }])).coins.beta;
    expect(beta.chain).toEqual([both.coins.beta.entry]);
  });

  it("a bundle of a shared pack is adopted for its own coin only (16 coins, 3 days)", async () => {
    const slugs = Array.from({ length: 16 }, (_, i) => `coin-${i}`);
    let parents = Object.fromEntries(slugs.map((s) => [s, undefined]));
    for (let n = 1; n <= 3; n++) {
      const pack = await w.writePack({ day: dayPlus(D0, n), run: 100 + n, release: TAG, coins: slugs.map((slug) => ({ slug, parent: parents[slug] })) });
      parents = pack.coins;
    }
    const out = await lane(slugs.map((slug) => ({ slug, main: null })));
    for (const slug of slugs) {
      expect(out.coins[slug].chain).toHaveLength(3);
      for (const e of out.coins[slug].chain) {
        const b = await readBundle({ blobs: w.blobs, slug, kind: KIND, bundleRef: e.bundle });
        expect(b.slug).toBe(slug);
      }
    }
  });
});

describe("the chain: parent links, tie-breaks, the longest", () => {
  it("within one day the higher run id wins; then the higher attempt; the listing order does not matter", async () => {
    const m = await mainRec();
    const day = dayPlus(D0, 1);
    const lo = await w.one({ slug: SLUG, day, run: 105, parent: m, release: TAG });
    const hi = await w.one({ slug: SLUG, day, run: 109, parent: m, release: TAG });
    expect((await adopt(m)).chain).toEqual([hi.entry]);
    expect(lo.key).not.toBe(hi.key);
    const a1 = await w.one({ slug: SLUG, day, run: 109, attempt: 1, lane: 1, parent: m, release: TAG });
    const a2 = await w.one({ slug: SLUG, day, run: 109, attempt: 2, parent: m, release: TAG });
    expect((await adopt(m)).chain).toEqual([a2.entry]);
    expect(a1.key).not.toBe(a2.key);
  });

  it("the longest chain wins over a shorter one with a higher run id", async () => {
    const m = await mainRec();
    const a = await next(m, 1, { run: 101 });
    const a2 = await next(a, 2, { run: 102 });
    await next(m, 1, { run: 190, lane: 1 });
    expect((await adopt(m)).chain).toEqual([a.entry, a2.entry]);
  });

  it("a bundle whose parent is outside the listing, when the listing stops at its maximum, is named as such (adoptionListing.test.js has the rule)", async () => {
    const m = await mainRec();
    // With data-live-3 current and at most 2 releases, data-live-1 is two releases back and is not listed.
    const hidden = await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 150, parent: m, release: "data-live-1" });
    await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 151, parent: hidden, release: "data-live-3" });
    const r = await adopt(m, { liveTag: "data-live-3", maxReleases: 2 });
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/listing does not reach back/);
  });

  it("no chain: the start is the main entry", async () => {
    const m = await mainRec();
    const r = await adopt(m);
    expect(r).toMatchObject({ chain: [], start: { source: "main", bundle: null } });
    expect(r.start.entry).toEqual(publishedOf(m));
    expect(why(r)).toMatch(/no adoptable bundle/);
  });

  it("a new coin: a chain from a null parent is adopted; nothing at all gives no start", async () => {
    expect(await adopt(null)).toMatchObject({ chain: [], start: null });
    const first = await w.one({ slug: SLUG, day: D0, run: 1, release: TAG });
    const second = await next(first, 1);
    const r = await adopt(null);
    expect(r.chain).toEqual([first.entry, second.entry]);
    expect(r.start).toMatchObject({ source: "adopted", entry: second.entry });
    expect((await accepted(null, r.chain)).status).toBe("accepted");
  });

  it("the same pack name in two releases is two objects, linked by full key", async () => {
    const m = await mainRec();
    const day = dayPlus(D0, 1);
    const copy1 = await w.one({ slug: SLUG, day, run: 101, parent: m, release: "data-live-1", salt: "first" });
    const copy2 = await w.one({ slug: SLUG, day, run: 101, parent: m, release: "data-live-2", salt: "second" });
    expect(copy1.key).not.toBe(copy2.key);
    const child1 = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 102, parent: copy1, release: TAG });
    let r = await adopt(m);
    expect(r.chain).toEqual([copy1.entry, child1.entry]);
    expect((await accepted(m, r.chain)).status).toBe("accepted");
    const child2 = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 103, parent: copy2, release: TAG });
    const grand2 = await w.one({ slug: SLUG, day: dayPlus(D0, 3), run: 104, parent: child2, release: TAG });
    r = await adopt(m);
    expect(r.chain).toEqual([copy2.entry, child2.entry, grand2.entry]);
  });
});

describe("the length bound: what the publish side refuses, adoption never hands back", () => {
  it("with no room kept for the run's own entry, 16 are adopted whole and pass acceptChain; the 17th is too long", async () => {
    const m = await mainRec();
    const recs = await chainOf(m, 17);
    const r = await adopt(m, { reserve: 0 });
    expect(r.chain).toHaveLength(16);
    expect(r.chain).toEqual(recs.slice(0, 16).map((x) => x.entry));
    expect(why(r)).toMatch(/too long/);
    expect((await accepted(m, r.chain)).status).toBe("accepted");
    expect((await accepted(m, recs.map((x) => x.entry))).reason).toMatch(/longer than the adoption window of 16 days/);
  });

  it("by default 15 are adopted, so the run's own entry makes 16 and the coin continues; 16 adopted would strand it", async () => {
    const m = await mainRec();
    const recs = await chainOf(m, 17);
    const r = await adopt(m);
    expect(r.chain).toHaveLength(15);
    expect(r.start.entry).toEqual(recs[14].entry);
    const own = await w.one({ slug: SLUG, day: dayPlus(D0, 20), run: 200, parent: recs[14], release: TAG });
    expect((await accepted(m, [...r.chain, own.entry])).status).toBe("accepted");
    const full = await adopt(m, { reserve: 0 });
    const ownAfter16 = await w.one({ slug: SLUG, day: dayPlus(D0, 20), run: 201, parent: recs[15], release: TAG });
    expect((await accepted(m, [...full.chain, ownAfter16.entry])).status).toBe("refused");
  });

  it("14, 15 and 16 candidates by default: all, all, and 15 with the rest named as too long", async () => {
    const m = await mainRec();
    await chainOf(m, 14);
    expect((await adopt(m)).chain).toHaveLength(14);
    await next(w.packs.at(-1).coins[SLUG], 15);
    const fifteen = await adopt(m);
    expect(fifteen.chain).toHaveLength(15);
    expect(why(fifteen)).not.toMatch(/too long/);
    await next(w.packs.at(-1).coins[SLUG], 16);
    const sixteen = await adopt(m);
    expect(sixteen.chain).toHaveLength(15);
    expect(why(sixteen)).toMatch(/1 bundle is too long/);
  });

  it("a reserve outside 0..15 is a named argument error", async () => {
    const m = await mainRec();
    await expect(adopt(m, { reserve: 16 })).rejects.toThrow(RecordShapeError);
    await expect(adopt(m, { reserve: -1 })).rejects.toThrow(RecordShapeError);
    await expect(adopt(m, { reserve: 0.5 })).rejects.toThrow(RecordShapeError);
  });
});

describe("a bad stored object drops its bundle and everything after it, and never throws", () => {
  const run = async (how) => {
    const m = await mainRec();
    const recs = await chainOf(m, 4);
    w.damage(recs[1], how);
    return { m, recs, r: await adopt(m) };
  };

  it("a damaged bundle item: the bundle is gone, the bundles after it have a broken link", async () => {
    const { recs, r } = await run("bundle");
    expect(r.chain).toEqual([recs[0].entry]);
    expect(why(r)).toMatch(/bad hash or unreadable/);
    expect(why(r)).toMatch(/broken link/);
  });

  it.each(["base", "blob"])("a damaged %s item the bundle names: it is dropped, the ones after it follow", async (how) => {
    const { recs, r } = await run(how);
    expect(r.chain).toEqual([recs[0].entry]);
    expect(why(r)).toMatch(/bad hash or unreadable/);
    expect(why(r)).toMatch(/follows a bundle that was dropped/);
  });

  it.each(["truncate", "magic"])("a pack that is %s: unreadable, the chain stops before it", async (how) => {
    const { recs, r } = await run(how);
    expect(r.chain).toEqual([recs[0].entry]);
    expect(why(r)).toMatch(/cannot be read/);
  });

  it("a damaged item in the middle: the other branch is adopted instead, and the damaged one named", async () => {
    const m = await mainRec();
    const x1 = await next(m, 1, { run: 101 });
    const x2 = await next(x1, 2, { run: 102 });
    const y1 = await next(m, 1, { run: 190, lane: 1 });
    w.damage(x2, "base");
    const r = await adopt(m);
    expect(r.chain).toEqual([y1.entry]);
    expect(r.chain).not.toContainEqual(x1.entry);
    expect(why(r)).toMatch(/bad hash or unreadable/);
  });

  it("an item damaged in the first bundle: nothing adopted, the start is the main entry", async () => {
    const m = await mainRec();
    const [a] = await chainOf(m, 2);
    w.damage(a, "blob");
    const r = await adopt(m);
    expect(r).toMatchObject({ chain: [], start: { source: "main" } });
  });

  it("a carried base damaged in the parent's pack drops the child too", async () => {
    const m = await mainRec();
    const [a, b] = await chainOf(m, 2);
    w.damage(a, "base");
    const r = await adopt(m);
    expect(r.chain).toEqual([]);
    expect(why(r)).toContain(`${b.bundleRef.ref} in ${b.bundleRef.release} follows a bundle that was dropped`);
  });
});

describe("a programming error is rethrown, never read as a bad object", () => {
  const flaky = (error, when) => ({ ...w.blobs, readRange: (loc, off, len) => { if (when(loc, off)) throw error; return w.blobs.readRange(loc, off, len); } });
  const run = (blobs) => adoptLane({ blobs, ...w.listing, liveTag: TAG, kind: KIND, coins: [{ slug: SLUG, main: null }] });

  it.each([TypeError, ReferenceError, RangeError])("%s while reading a header", async (E) => {
    await w.one({ slug: SLUG, day: D0, run: 1, release: TAG });
    await expect(run(flaky(new E("boom"), () => true))).rejects.toThrow(E);
  });
  it.each([TypeError, ReferenceError, RangeError])("%s while reading a bundle (the bundle reader wraps it; the cause is checked)", async (E) => {
    await w.one({ slug: SLUG, day: D0, run: 1, release: TAG });
    await expect(run(flaky(new E("boom"), (_, off) => off > 0))).rejects.toThrow(E);
  });
  it.each([TypeError, ReferenceError, RangeError])("%s while verifying an item", async (E) => {
    const rec = await w.one({ slug: SLUG, day: D0, run: 1, release: TAG });
    const skip = new Set([rec.items.bundle.off + rec.packInfo.bodyStart]);
    await expect(run(flaky(new E("boom"), (_, off) => off > 0 && !skip.has(off)))).rejects.toThrow(E);
  });
  it("a rate limit is not a bad object either", async () => {
    await w.one({ slug: SLUG, day: D0, run: 1, release: TAG });
    const r = (await run(flaky(new StoreRateLimitError("slow down"), () => true))).coins[SLUG];
    expect(r).toMatchObject({ failed: true, chain: null, start: null });
    expect(r.error.cause).toBeInstanceOf(StoreRateLimitError); // the header read of the only pack
    expect(r.alerts).toEqual([{ code: "unreadable", count: 1 }]);
  });
});

describe("arguments", () => {
  it("does not change the main entry, and returns objects of its own", async () => {
    const m = await mainRec();
    const main = publishedOf(m);
    const frozen = structuredClone(main);
    const deep = (o) => { Object.values(o).forEach((v) => v && typeof v === "object" && deep(v)); return Object.freeze(o); };
    deep(main);
    const r = await lane([{ slug: SLUG, main }]);
    expect(main).toEqual(frozen);
    expect(r.coins[SLUG].start.entry).toEqual(frozen);
    expect(r.coins[SLUG].start.entry).not.toBe(main);
  });

  it("a main entry that is not a published entry, or a bad slug or kind, is a named shape error", async () => {
    const m = await mainRec();
    await expect(lane([{ slug: SLUG, main: m.entry }])).rejects.toThrow(RecordShapeError);
    await expect(lane([{ slug: "../x", main: null }])).rejects.toThrow(RecordShapeError);
    await expect(lane([{ slug: SLUG, main: null }], { kind: "Holders" })).rejects.toThrow(RecordShapeError);
    await expect(lane([{ slug: SLUG, main: null }, { slug: SLUG, main: null }])).rejects.toThrow(/twice/);
    await expect(lane([{ slug: SLUG, main: { ...publishedOf(m), bundle: null } }])).rejects.toThrow(RecordShapeError);
  });

  it("a main entry of another kind than the run's is refused", async () => {
    const ledger = await w.one({ slug: SLUG, kind: "ledger", day: D0, run: 1, release: TAG });
    await expect(lane([{ slug: SLUG, main: published(ledger.entry, AT) }])).rejects.toThrow(RecordShapeError);
  });
});

describe("the lane listing", () => {
  const SINCE = Date.parse("2026-11-10T00:00:00Z");
  const existing = async () => ({ tags: [], requests: 1 });
  // A release whose one asset was created before T: the rule holds at once.
  const aged = (requests, seen = []) => async (tag) => {
    seen.push(tag);
    return { entries: [{ name: "old", loc: `${tag}/old`, release: tag, state: "uploaded", size: 1, createdAt: "2026-11-01T00:00:00Z" }], requests };
  };
  const base = { existingReleases: existing, since: SINCE };

  it("lists the current live release and the one before it, once each", async () => {
    const seen = [];
    const listing = await listLane({ ...base, liveTag: "data-live-7", listRelease: aged(3, seen) });
    expect(seen).toEqual(["data-live-7", "data-live-6"]);
    expect(listing).toMatchObject({ tags: ["data-live-7", "data-live-6"], requests: 6, budget: LANE_LISTING_REQUESTS, overBudget: false });
    expect(LANE_LISTING_REQUESTS).toBe(18);
  });

  it("the first release has no release before it", async () => {
    const seen = [];
    await listLane({ ...base, liveTag: "data-live-1", listRelease: aged(1, seen) });
    expect(seen).toEqual(["data-live-1"]);
  });

  it("reports the requests, and flags a listing over the 9 requests a release of the design", async () => {
    expect((await listLane({ ...base, liveTag: "data-live-3", listRelease: aged(9) })).overBudget).toBe(false);
    expect((await listLane({ ...base, liveTag: "data-live-3", listRelease: aged(10) }))).toMatchObject({ requests: 20, overBudget: true });
  });

  it("a bad answer from the listing call, or a tag that is not a live release, is a named error", async () => {
    const ok = async () => ({ entries: [], requests: 1 });
    await expect(listLane({ ...base, liveTag: "data-keep-1", listRelease: ok })).rejects.toThrow(AdoptionListingError);
    await expect(listLane({ ...base, liveTag: "nonsense", listRelease: ok })).rejects.toThrow(AdoptionListingError);
    await expect(listLane({ ...base, liveTag: TAG, listRelease: async () => ({ entries: "x", requests: 1 }) })).rejects.toThrow(/listRelease must answer/);
    await expect(listLane({ ...base, liveTag: TAG, listRelease: async () => ({ entries: [], requests: -1 }) })).rejects.toThrow(AdoptionListingError);
    await expect(listLane({ ...base, liveTag: TAG, listRelease: async () => ({ entries: [], requests: 1.5 }) })).rejects.toThrow(/requests/);
    await expect(listLane({ ...base, liveTag: TAG, listRelease: undefined })).rejects.toThrow(AdoptionListingError);
  });

  it("a lane with no coins still lists once and returns no coin", async () => {
    const out = await lane([]);
    expect(out.coins).toEqual({});
    expect(w.calls.listRelease).toBe(2);
  });
});

describe("on the release backend", () => {
  it("adopts a chain of two from packs uploaded through the fake release server", async () => {
    w.cleanup();
    w = createWorld({ backend: "release" });
    const m = await w.one({ slug: SLUG, day: D0, run: 100 });
    const a = await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 101, parent: m });
    const b = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 102, parent: a });
    const out = await adoptLane({ blobs: w.blobs, ...w.listing, liveTag: "data-live-1", kind: KIND, coins: [{ slug: SLUG, main: publishedOf(m) }] });
    expect(out.coins[SLUG].chain).toEqual([a.entry, b.entry]);
    expect((await accepted(m, out.coins[SLUG].chain)).status).toBe("accepted");
    expect(keys(out.coins[SLUG])).toHaveLength(2);
  });
});
