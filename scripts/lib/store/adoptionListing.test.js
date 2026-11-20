import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptChain } from "./acceptChain.js";
import { AdoptionListingError } from "./errors.js";
import { NOW, createWorld, dayPlus, publishedOf } from "./adoptionKit.js";
import { DEFAULT_MAX_RELEASES, adoptLane, listLane } from "./adoptionLane.js";

// Fix round 2, item 4: the listing reaches back by a rule, not by a count. It covers everything
// uploaded since T when the lowest listed release is the lowest release that exists, or holds an
// asset created before T (less the uploader's learning lag). T is the start of the earliest main day
// among the lane's coins, with no floor (fix round 3); a new coin has no bound at all (round 4).
const SLUG = "example";
const KIND = "holders";
const D0 = "2026-11-10";
const NOW_MS = Date.parse(NOW);
const FLOOR = new Date(NOW_MS - 16 * 86400000).toISOString(); // 2026-11-03T06:00:00.000Z
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());

const rel = (n) => `data-live-${n}`;
const mainRec = (over = {}) => w.one({ slug: SLUG, day: D0, run: 100, release: rel(1), ...over });
const lane = (liveTag, coins, over = {}) => adoptLane({ blobs: w.blobs, ...w.listing, liveTag, kind: KIND, coins, ...over });
const coin = (slug, main) => ({ slug, main: main ? publishedOf(main) : null });
const why = (r) => r.why.join("\n");
const alertOf = (r, code) => r.alerts.find((a) => a.code === code);

// One bundle a day, day n in release n + 1: a backlog that spans `count` releases above main's.
async function backlog(main, count) {
  const chain = [];
  for (let n = 1; n <= count; n++) chain.push(await w.one({ slug: SLUG, day: dayPlus(D0, n), run: 100 + n, parent: chain.at(-1) ?? main, release: rel(n + 1) }));
  return chain;
}

describe("finding D: the reason is the listing only when the listing is the reason", () => {
  it("damage is blamed on the damage: the parent pack is dated after the day after main, and is damaged", async () => {
    const m = await mainRec();
    const d12 = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 102, parent: m, release: rel(2) }); // the day-11 lane died
    await w.one({ slug: SLUG, day: dayPlus(D0, 3), run: 103, parent: d12, release: rel(2) });
    w.damage(d12, "magic");
    fs.rmSync(path.join(w.dir, rel(1)), { recursive: true }); // main's release is gone: the oldest pack left is the damaged one
    const r = (await lane(rel(2), [coin(SLUG, m)])).coins[SLUG];
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/broken link/);
    expect(why(r)).not.toMatch(/listing does not reach back/);
    expect(alertOf(r, "listing-too-shallow")).toBeUndefined();
    expect(alertOf(r, "damaged")).toBeDefined();
  });

  it("a pack uploaded late with an old day does not hide a shallow listing", async () => {
    const m = await mainRec();
    const hidden = await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 150, parent: m, release: rel(1) });
    const top = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 151, parent: hidden, release: rel(3) });
    await w.one({ slug: "other", day: dayPlus(D0, -5), run: 7, release: rel(3), createdAt: "2026-11-12T00:00:00Z" });
    const shallow = await lane(rel(3), [coin(SLUG, m)], { maxReleases: 2 });
    const r = shallow.coins[SLUG];
    expect(r.chain).toEqual([]);
    expect(why(r)).toMatch(/listing does not reach back/);
    expect(alertOf(r, "listing-too-shallow")).toEqual({ code: "listing-too-shallow", count: 1 });
    expect(shallow.listing.shallow).toBe(true);
    const deeper = (await lane(rel(3), [coin(SLUG, m)], { maxReleases: 3 }));
    expect(deeper.coins[SLUG].chain).toEqual([hidden.entry, top.entry]);
    expect(deeper.coins[SLUG].alerts).toEqual([]);
    expect(deeper.listing.shallow).toBe(false);
  });
});

describe("the listing goes down existing releases until the rule holds", () => {
  for (const count of [3, 4]) {
    it(`a backlog of ${count} releases is adopted whole: ${count + 1} releases listed plus one request for the release tags`, async () => {
      const m = await mainRec();
      const chain = await backlog(m, count);
      const out = await lane(rel(count + 1), [coin(SLUG, m)]);
      expect(out.coins[SLUG].chain).toEqual(chain.map((c) => c.entry));
      expect(out.coins[SLUG].alerts).toEqual([]);
      expect(out.listing.tags).toEqual(Array.from({ length: count + 1 }, (_, i) => rel(count + 1 - i)));
      expect(out.listing).toMatchObject({ requests: count + 2, shallow: false, overBudget: false });
      expect(w.calls.existingReleases).toBe(1);
      expect((await acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: publishedOf(m), chain: out.coins[SLUG].chain })).status).toBe("accepted");
    });
  }

  it("the rule holds by date when the lowest listed release holds an asset created before T: no request for the release tags", async () => {
    const m = await mainRec();
    const chain = await backlog(m, 2);
    await w.one({ slug: "other", day: "2026-11-01", run: 5, release: rel(2) }); // created 2026-11-01, before T = 2026-11-10
    const out = await lane(rel(3), [coin(SLUG, m)]);
    expect(out.listing).toMatchObject({ tags: [rel(3), rel(2)], requests: 2, shallow: false });
    expect(out.coins[SLUG].chain).toEqual(chain.map((c) => c.entry));
    expect(w.calls.existingReleases).toBe(0);
  });

  it("release 1 is the lowest there can be: no request for the release tags", async () => {
    const m = await mainRec();
    await backlog(m, 1);
    const out = await lane(rel(2), [coin(SLUG, m)]);
    expect(out.listing).toMatchObject({ tags: [rel(2), rel(1)], requests: 2 });
    expect(w.calls.existingReleases).toBe(0);
  });

  it("the maximum is hit without the rule holding: shallow, and every coin of the lane is told", async () => {
    const m = await mainRec();
    await backlog(m, 4);
    const y = await w.one({ slug: "coin-y", day: dayPlus(D0, 4), run: 90, release: rel(5) });
    const out = await lane(rel(5), [coin(SLUG, m), coin("coin-y", null)], { maxReleases: 3 });
    expect(out.listing).toMatchObject({ tags: [rel(5), rel(4), rel(3)], requests: 4, shallow: true });
    for (const slug of [SLUG, "coin-y"]) expect(alertOf(out.coins[slug], "listing-too-shallow")).toEqual({ code: "listing-too-shallow", count: 1 });
    expect(out.coins[SLUG].chain).toEqual([]);
    expect(why(out.coins[SLUG])).toMatch(/listing does not reach back/);
    expect(out.coins["coin-y"].chain).toEqual([y.entry]);
  });

  it("the default maximum is 8 releases", async () => {
    expect(DEFAULT_MAX_RELEASES).toBe(8);
    const m = await mainRec();
    await backlog(m, 9); // lives in releases 2 to 10
    const out = await lane(rel(10), [coin(SLUG, m)]);
    expect(out.listing.tags).toHaveLength(8);
    expect(out.listing.shallow).toBe(true);
  });
});

describe("T: the earliest main day of the lane's coins; a new coin has no bound", () => {
  it("is the start of the main day", async () => {
    const m = await mainRec();
    expect((await lane(rel(2), [coin(SLUG, m)])).listing.since).toBe("2026-11-10T00:00:00.000Z");
  });

  it("is the earliest of the lane's main days", async () => {
    const m = await mainRec();
    const later = await w.one({ slug: "coin-b", day: "2026-11-12", run: 99, release: rel(1) });
    expect((await lane(rel(2), [coin("coin-b", later), coin(SLUG, m)])).listing.since).toBe("2026-11-10T00:00:00.000Z");
  });

  it("a main day older than the window is still T: there is no floor for a coin with a main entry", async () => {
    const old = await w.one({ slug: SLUG, day: "2026-10-01", run: 3, release: rel(1) });
    expect((await lane(rel(2), [coin(SLUG, old)])).listing.since).toBe("2026-10-01T00:00:00.000Z");
  });

  it("a new coin has no bound, and neither has a lane with a new coin next to a coin with a main entry", async () => {
    const m = await mainRec();
    expect((await lane(rel(2), [coin("coin-n", null)])).listing.since).toBe("1970-01-01T00:00:00.000Z");
    expect((await lane(rel(2), [coin(SLUG, m), coin("coin-n", null)])).listing.since).toBe("1970-01-01T00:00:00.000Z");
  });

  it("T changes what counts as old: an asset from 2026-11-05 is before T for a main day 11-10, not for a new coin", async () => {
    const m = await mainRec();
    await w.one({ slug: "other", day: "2026-11-05", run: 5, release: rel(2) });
    await w.one({ slug: "other", day: "2026-11-04", run: 4, release: rel(1) });
    const withMain = await lane(rel(3), [coin(SLUG, m)]);
    expect(withMain.listing.tags).toEqual([rel(3), rel(2)]);
    const fresh = await lane(rel(3), [coin("coin-n", null)]);
    expect(fresh.listing.tags).toEqual([rel(3), rel(2), rel(1)]);
  });
});

describe("listLane: the injected calls", () => {
  const entry = (tag, createdAt) => ({ name: `p.live.holders.2026-11-12.r1a1.l0f0.hdb`, loc: `${tag}/p`, release: tag, state: "uploaded", size: 1, createdAt });
  const since = Date.parse("2026-11-10T00:00:00Z");

  it("lists the two newest, then continues down the releases that exist, skipping the gaps", async () => {
    const fake = { seen: [] };
    const tags = ["data-live-9", "data-live-8", "data-live-5", "data-live-4"];
    const listing = await listLane({
      liveTag: "data-live-9", since,
      existingReleases: async () => ({ tags, requests: 1 }),
      listRelease: async (tag) => { fake.seen.push(tag); return { entries: [entry(tag, NOW)], requests: 2 }; },
    });
    expect(fake.seen).toEqual(["data-live-9", "data-live-8", "data-live-5", "data-live-4"]);
    expect(listing).toMatchObject({ requests: 9, budget: 37, shallow: false });
  });

  it("answers must be { tags, requests } and a since must be a time", async () => {
    const base = { liveTag: "data-live-9", since, listRelease: async (tag) => ({ entries: [entry(tag, NOW)], requests: 1 }) };
    await expect(listLane({ ...base, existingReleases: undefined })).rejects.toThrow(AdoptionListingError);
    await expect(listLane({ ...base, existingReleases: async () => ({ tags: "x", requests: 1 }) })).rejects.toThrow(AdoptionListingError);
    await expect(listLane({ ...base, existingReleases: async () => ({ tags: [], requests: -1 }) })).rejects.toThrow(AdoptionListingError);
    await expect(listLane({ ...base, existingReleases: async () => ({ tags: [], requests: 1 }), since: "2026-11-10" })).rejects.toThrow(AdoptionListingError);
    for (const maxReleases of [0, 1.5, -1, "2"]) await expect(listLane({ ...base, existingReleases: async () => ({ tags: [], requests: 1 }), maxReleases })).rejects.toThrow(AdoptionListingError);
  });

  it("a lane needs a clock", async () => {
    await expect(adoptLane({ blobs: w.blobs, listRelease: w.listRelease, existingReleases: w.existingReleases, liveTag: rel(2), kind: KIND, coins: [] })).rejects.toThrow(AdoptionListingError);
  });
});
