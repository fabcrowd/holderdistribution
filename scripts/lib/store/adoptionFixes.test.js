import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptChain } from "./acceptChain.js";
import { createWorld, dayPlus, publishedOf, spyBlobs } from "./adoptionKit.js";
import { adoptLane } from "./adoptionLane.js";
import { PackUnreadableError } from "./adoptionReads.js";
import { StoreNotFoundError, StoreRangeError } from "./blobStore.js";

// The cold review's fixes: a failure to obtain bytes is never proof of a bad object; days never
// go backwards along a chain; alerts as data; the listing's depth; the verified-item key.
const SLUG = "example";
const KIND = "holders";
const TAG = "data-live-2";
const D0 = "2026-11-10";
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());

const mainRec = (over = {}) => w.one({ slug: SLUG, day: D0, run: 100, release: "data-live-1", ...over });
const lane = (main, over = {}) => adoptLane({ blobs: w.blobs, ...w.listing, liveTag: TAG, kind: KIND, coins: [{ slug: SLUG, main: main ? publishedOf(main) : null }], ...over });
const adopt = async (main, over) => (await lane(main, over)).coins[SLUG];
const next = (parent, n, over = {}) => w.one({ slug: SLUG, day: dayPlus(D0, n), run: 100 + n, parent, release: TAG, ...over });
const why = (r) => r.why.join("\n");
const alertOf = (r, code) => r.alerts.find((a) => a.code === code);

describe("fix 1: a failure to obtain bytes is transient, never a reason to shorten the chain (the coin fails tonight)", () => {
  async function threeDays() {
    const m = await mainRec();
    const a = await next(m, 1);
    const b = await next(a, 2, { createdAt: "2026-11-18T20:00:00Z" }); // young: the bound has not passed
    return { m, a, b };
  }
  const failing = (error, when) => ({ ...w.blobs, readRange: async (loc, off, len) => { if (when(loc, off)) throw error; return w.blobs.readRange(loc, off, len); } });
  const run = (blobs, main) => adoptLane({ blobs, ...w.listing, liveTag: TAG, kind: KIND, coins: [{ slug: SLUG, main: publishedOf(main) }] });
  const failed = async (blobs, main) => (await run(blobs, main)).coins[SLUG];
  // A header read that fails makes the pack unreadable (the error is the cause); any other read fails the coin with it.
  const causeOf = (e) => (e instanceof PackUnreadableError ? e.cause : e);

  it("P2: one read of the newest pack fails after retries: the coin fails, it never gets the shortened chain", async () => {
    const { m, b } = await threeDays();
    const r = await failed(failing(new StoreRangeError("short body after 3 attempts"), (loc) => loc === b.packInfo.loc), m);
    expect(r).toMatchObject({ failed: true, chain: null, start: null });
    expect(causeOf(r.error)).toBeInstanceOf(StoreRangeError);
  });

  const stages = [
    ["the header read", (rec) => (loc, off) => loc === rec.packInfo.loc && off === 0],
    ["the bundle read", (rec) => (loc, off) => loc === rec.packInfo.loc && off === rec.packInfo.bodyStart + rec.items.bundle.off],
    ["an item read", (rec) => (loc, off) => loc === rec.packInfo.loc && off === rec.packInfo.bodyStart + rec.items.base.off],
  ];
  const causes = [
    ["StoreRangeError after retries", () => new StoreRangeError("short body after 3 attempts")],
    ["StoreNotFoundError from the download host", () => new StoreNotFoundError("not found: 404")],
  ];
  for (const [stage, when] of stages) {
    for (const [cause, make] of causes) {
      it(`${cause} at ${stage} of a listed pack fails the coin`, async () => {
        const { m, b } = await threeDays();
        const r = await failed(failing(make(), when(b)), m);
        expect(r).toMatchObject({ failed: true, chain: null });
        expect(causeOf(r.error)).toBeInstanceOf(make().constructor);
      });
    }
  }

  it("a short body returned by the store is a failure to obtain bytes: the coin fails", async () => {
    const { m, b } = await threeDays();
    const blobs = { ...w.blobs, readRange: async (loc, off, len) => (loc === b.packInfo.loc && off > 0 ? (await w.blobs.readRange(loc, off, len)).subarray(0, len - 1) : w.blobs.readRange(loc, off, len)) };
    const r = await failed(blobs, m);
    expect(r).toMatchObject({ failed: true, chain: null });
    expect(causeOf(r.error)).toBeInstanceOf(StoreRangeError);
  });

  it("each cause that is evidence from bytes or known sizes still drops", async () => {
    for (const how of ["bundle", "base", "blob", "truncate", "magic", "append"]) {
      w.cleanup();
      w = createWorld();
      const { m, a, b } = await threeDays();
      w.damage(b, how);
      const r = await adopt(m);
      expect(r.chain, how).toEqual([a.entry]);
    }
  });

  it("a carried pack whose size no longer matches its row (a row mismatch) drops the bundle that carries it", async () => {
    const m = await mainRec();
    await next(m, 1);
    w.damage({ ...m, packInfo: m.packInfo }, "append");
    const r = await adopt(m);
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/bad hash or unreadable/);
  });

  describe("a not-found on a pack that is not in the listing is believed only when stat confirms it", () => {
    // data-live-3 is current and at most 2 releases are listed: main's pack in data-live-1 is not
    // listed, but A carries its base. Both packs are young (stat gives the carried pack's own creation
    // time), so a pack that cannot be read is transient.
    const setup = async () => {
      const m = await mainRec({ createdAt: "2026-11-18T10:00:00Z" });
      const a = await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 101, parent: m, release: "data-live-3", createdAt: "2026-11-18T20:00:00Z" });
      return { m, a };
    };
    const opts = { liveTag: "data-live-3", maxReleases: 2 };

    it("confirmed gone: the bundle is dropped, one confirmation request is counted", async () => {
      const { m } = await setup();
      w.remove(m.packInfo);
      const spy = spyBlobs(w.blobs);
      const out = await adoptLane({ blobs: spy.blobs, ...w.listing, ...opts, kind: KIND, coins: [{ slug: SLUG, main: publishedOf(m) }] });
      expect(out.coins[SLUG].chain).toEqual([]);
      expect(why(out.coins[SLUG])).toMatch(/gone/);
      expect(out.reads.confirmations).toBe(1);
      expect(spy.log.filter((e) => e.op === "stat" && e.loc === m.packInfo.loc)).toHaveLength(2); // the item store's own, and the confirmation
    });

    it("stat finds the pack: the not-found is transient and the coin fails tonight", async () => {
      const { m } = await setup();
      const spy = spyBlobs(failing(new StoreNotFoundError("not found: cdn 404"), (loc) => loc === m.packInfo.loc));
      const out = await adoptLane({ blobs: spy.blobs, ...w.listing, ...opts, kind: KIND, coins: [{ slug: SLUG, main: publishedOf(m) }] });
      expect(out.coins[SLUG]).toMatchObject({ failed: true, chain: null });
      expect(out.coins[SLUG].error.cause).toBeInstanceOf(StoreNotFoundError);
      expect(spy.log.filter((e) => e.op === "stat" && e.loc === m.packInfo.loc)).toHaveLength(2);
    });

    it("a listed uploaded pack is confirmed too: stat finds it, so the coin fails tonight", async () => {
      const { a } = await setup();
      const spy = spyBlobs(failing(new StoreNotFoundError("not found"), (loc, off) => loc === a.packInfo.loc && off > 0));
      const out = await adoptLane({ blobs: spy.blobs, ...w.listing, ...opts, kind: KIND, coins: [{ slug: SLUG, main: null }] });
      expect(out.coins[SLUG].error.cause).toBeInstanceOf(StoreNotFoundError);
      expect(out.reads.confirmations).toBe(1);
    });
  });
});

describe("fix 2: days never go backwards along a chain", () => {
  it("P1: main day 10, A day 12, B day 11 with parent A: B is dropped as going backwards, and acceptChain refuses the chain", async () => {
    const m = await mainRec();
    const a = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 102, parent: m, release: TAG });
    const b = await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 101, parent: a, release: TAG });
    const r = await adopt(m);
    expect(r.chain).toEqual([a.entry]);
    expect(why(r)).toMatch(/day goes backwards/);
    expect(alertOf(r, "day-backwards")).toEqual({ code: "day-backwards", count: 1 });
    const judged = await acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: publishedOf(m), chain: [a.entry, b.entry] });
    expect(judged.status).toBe("refused");
    expect(judged.reason).toMatch(/day goes backwards/);
  });

  it("an equal day is allowed (a kind may publish twice a day)", async () => {
    const m = await mainRec();
    const a = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 102, parent: m, release: TAG });
    const b = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 103, parent: a, release: TAG });
    expect((await adopt(m)).chain).toEqual([a.entry, b.entry]);
    expect((await acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: publishedOf(m), chain: [a.entry, b.entry] })).status).toBe("accepted");
  });

  it("the first bundle must be on or after the main entry's day, though its pack is dated after it", async () => {
    const m = await mainRec();
    const early = await w.one({ slug: SLUG, day: dayPlus(D0, 1), bundleDay: dayPlus(D0, -1), run: 101, parent: m, release: TAG });
    let r = await adopt(m);
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/day goes backwards/);
    expect((await acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: publishedOf(m), chain: [early.entry] })).status).toBe("refused");
    const same = await w.one({ slug: SLUG, day: dayPlus(D0, 1), bundleDay: D0, run: 102, parent: m, release: TAG, lane: 1 });
    r = await adopt(m);
    expect(r.chain).toEqual([same.entry]);
  });

  it("the bundles after a backwards one follow it down, and a sibling branch is still adopted", async () => {
    const m = await mainRec();
    const a = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 102, parent: m, release: TAG });
    const b = await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 101, parent: a, release: TAG });
    await w.one({ slug: SLUG, day: dayPlus(D0, 3), run: 103, parent: b, release: TAG });
    const r = await adopt(m);
    expect(r.chain).toEqual([a.entry]);
    expect(why(r)).toMatch(/follows a bundle that was dropped/);
  });
});

// The listing's depth is a rule since fix round 2 (adoptionListing.test.js); the count of releases
// and the "oldest pack day" test of round 1 are gone with it.
describe("fix 4: the listing reports the packs it reaches", () => {
  it("the lane result reports the oldest and newest pack day of the kind the listing reaches", async () => {
    const m = await mainRec();
    await next(m, 1);
    await next(w.packs.at(-1).coins[SLUG], 3);
    await w.one({ slug: SLUG, kind: "ledger", day: "2026-01-01", run: 1, release: TAG });
    const out = await lane(m);
    expect(out.listing).toMatchObject({ oldestPackDay: D0, newestPackDay: dayPlus(D0, 3) });
  });

});

describe("fix 5: alerts as data", () => {
  it("more than 15 unpublished bundles: too-long with the number left behind", async () => {
    const m = await mainRec();
    let parent = m;
    for (let n = 1; n <= 17; n++) parent = await next(parent, n);
    const r = await adopt(m);
    expect(r.chain).toHaveLength(15);
    expect(alertOf(r, "too-long")).toEqual({ code: "too-long", count: 2 });
    expect(why(r)).toMatch(/never publishes them/);
  });

  it("damaged: the number of bundles dropped for a bad hash or an unreadable pack", async () => {
    const m = await mainRec();
    const a = await next(m, 1);
    const b = await next(a, 2);
    w.damage(b, "base");
    expect(alertOf(await adopt(m), "damaged")).toEqual({ code: "damaged", count: 1 });
  });

  it("a quiet night has no alerts", async () => {
    const m = await mainRec();
    await next(m, 1);
    expect((await adopt(m)).alerts).toEqual([]);
  });
});

describe("fix 6: a verified item is keyed by its pack row too", () => {
  it("a bundle that carries a base under a different row for the same pack is verified again, and dropped on the row mismatch", async () => {
    const m = await mainRec();
    const a = await next(m, 1);
    await next(a, 2, { tamperRow: (row) => ({ ...row, headerSha256: "f".repeat(64) }) });
    const r = await adopt(m);
    expect(r.chain).toEqual([a.entry]);
    expect(why(r)).toMatch(/bad hash or unreadable/);
  });
});
