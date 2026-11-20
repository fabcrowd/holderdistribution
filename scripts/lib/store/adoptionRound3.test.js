import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptChain } from "./acceptChain.js";
import { AdoptionListingError } from "./errors.js";
import { NOW, createWorld, dayPlus, publishedOf } from "./adoptionKit.js";
import { adoptLane, listLane, listingSince } from "./adoptionLane.js";
import { StoreRangeError } from "./blobStore.js";
import { ADOPTION_WINDOW_DAYS, NEWEST_RELEASE_MAX_AGE_MS, SECOND_LOOK_SHARE_MS, SECOND_LOOK_WAIT_MS } from "./storeConstants.js";

// Fix round 3 (REVIEW-3): the listing has no floor for a coin with a main entry, an unreachable
// unpublished bundle is alerted, and a pack past the bound gets a second look before it is dropped.
const SLUG = "example";
const KIND = "holders";
const TAG = "data-live-2";
const D0 = "2026-11-10";
const D1 = dayPlus(D0, 1);
const D2 = dayPlus(D0, 2);
const NOW_MS = Date.parse(NOW);
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());

const rel = (n) => `data-live-${n}`;
const lane = (liveTag, coins, over = {}) => adoptLane({ blobs: w.blobs, ...w.listing, liveTag, kind: KIND, coins: coins.map(([slug, main]) => ({ slug, main: main ? publishedOf(main) : null })), ...over });
const alertOf = (r, code) => r.alerts.find((a) => a.code === code);
const why = (r) => r.why.join("\n");
// Fails the first `times` reads of `loc` at or after `from` bytes (every read when times is Infinity).
const flaky = ({ loc, from = 0, at = null, times = 1 }) => {
  let left = times;
  return {
    ...w.blobs,
    readRange: async (l, off, len) => {
      if (l === loc && (at === null ? off >= from : off === at) && left-- > 0) throw new StoreRangeError("short body after 3 attempts");
      return w.blobs.readRange(l, off, len);
    },
  };
};

describe("item 1 (P6): no floor for a coin with a main entry", () => {
  it("24 unpublished bundles across three releases, main 25 days back: the listing reaches the oldest and the coin adopts the oldest 15", async () => {
    const day0 = "2026-10-25";
    const m = await w.one({ slug: SLUG, day: day0, run: 100, release: rel(1) });
    const chain = [];
    for (let n = 1; n <= 24; n++) chain.push(await w.one({ slug: SLUG, day: dayPlus(day0, n), run: 100 + n, parent: chain.at(-1) ?? m, release: rel(Math.ceil(n / 8)) }));
    const out = await lane(rel(3), [[SLUG, m]]);
    const r = out.coins[SLUG];
    expect(out.listing).toMatchObject({ tags: [rel(3), rel(2), rel(1)], shallow: false, since: "2026-10-25T00:00:00.000Z" });
    expect(r.chain).toEqual(chain.slice(0, 15).map((c) => c.entry));
    expect(r.alerts).toEqual([{ code: "too-long", count: 9 }]);
    expect((await acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: publishedOf(m), chain: r.chain })).status).toBe("accepted");
  });

  it("listingSince: the earliest main day with no floor, and no bound at all for a coin with no main entry", () => {
    const main = (day) => ({ day });
    const floor = NOW_MS - ADOPTION_WINDOW_DAYS * 86400000;
    expect(listingSince([{ main: main("2026-10-01") }], NOW_MS)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(listingSince([{ main: main("2026-11-15") }], NOW_MS)).toBe(Date.parse("2026-11-15T00:00:00Z"));
    expect(listingSince([{ main: null }], NOW_MS)).toBe(0);
    expect(listingSince([{ main: main("2026-10-01") }, { main: null }], NOW_MS)).toBe(0);
    expect(listingSince([], NOW_MS)).toBe(floor);
  });

  it("a main day too old for the maximum of releases is shallow, with the alert, never silent", async () => {
    const m = await w.one({ slug: SLUG, day: "2026-10-01", run: 100, release: rel(1) });
    await w.one({ slug: SLUG, day: "2026-11-18", run: 200, parent: m, release: rel(4) });
    for (const n of [2, 3]) await w.one({ slug: "other", day: dayPlus("2026-11-10", n), run: n, release: rel(n) });
    const out = await lane(rel(4), [[SLUG, m]], { maxReleases: 2 });
    expect(out.listing.shallow).toBe(true);
    expect(alertOf(out.coins[SLUG], "listing-too-shallow")).toEqual({ code: "listing-too-shallow", count: 1 });
  });
});

describe("item 1 (finding 5): the stop rule allows for the uploader's learning lag", () => {
  const since = Date.parse("2026-11-10T00:00:00Z");
  const entry = (tag, createdAt) => ({ name: "p.live.holders.2026-11-12.r1a1.l0f0.hdb", loc: `${tag}/p`, release: tag, state: "uploaded", size: 1, createdAt });
  const listWith = async (lowestCreated) => {
    const seen = [];
    await listLane({
      liveTag: "data-live-9", since,
      existingReleases: async () => ({ tags: ["data-live-9", "data-live-8", "data-live-5"], requests: 1 }),
      listRelease: async (tag) => { seen.push(tag); return { entries: [entry(tag, tag === "data-live-8" ? new Date(lowestCreated).toISOString() : NOW)], requests: 1 }; },
    });
    return seen;
  };

  it("an asset created less than the lag before T does not stop the listing: the release below may still receive an upload", async () => {
    expect(await listWith(since - NEWEST_RELEASE_MAX_AGE_MS / 2)).toEqual(["data-live-9", "data-live-8", "data-live-5"]);
  });

  it("an asset created more than the lag before T stops it", async () => {
    expect(await listWith(since - NEWEST_RELEASE_MAX_AGE_MS - 1000)).toEqual(["data-live-9", "data-live-8"]);
  });
});

describe("item 2: an unpublished bundle that cannot be reached is never silent", () => {
  async function brokenChain() {
    const m = await w.one({ slug: SLUG, day: D0, run: 100, release: rel(1) });
    const a = await w.one({ slug: SLUG, day: D1, run: 101, parent: m, release: TAG });
    const b = await w.one({ slug: SLUG, day: D2, run: 102, parent: a, release: TAG });
    const c = await w.one({ slug: SLUG, day: dayPlus(D0, 3), run: 103, parent: b, release: TAG });
    return { m, a, b, c };
  }

  it("the parent pack is not there: every readable bundle after it is counted as broken-link, and nothing else is alerted", async () => {
    const { m, a } = await brokenChain();
    w.remove(a.packInfo);
    const r = (await lane(TAG, [[SLUG, m]])).coins[SLUG];
    expect(r.chain).toEqual([]);
    expect(r.alerts).toEqual([{ code: "broken-link", count: 2 }]);
  });

  it("a damaged parent pack: damaged for the pack, broken-link for the bundles that lost their parent", async () => {
    const { m, a } = await brokenChain();
    w.damage(a.packInfo, "magic");
    const r = (await lane(TAG, [[SLUG, m]])).coins[SLUG];
    expect(r.alerts).toEqual([{ code: "broken-link", count: 2 }, { code: "damaged", count: 1 }]);
  });

  it("an intact chain has no broken-link", async () => {
    const { m } = await brokenChain();
    expect((await lane(TAG, [[SLUG, m]])).coins[SLUG].alerts).toEqual([]);
  });

  it("a shallow listing alerts listing-too-shallow, which already names the missing parent, and not broken-link", async () => {
    const m = await w.one({ slug: SLUG, day: D0, run: 100, release: rel(1) });
    const hidden = await w.one({ slug: SLUG, day: D1, run: 150, parent: m, release: rel(1) });
    await w.one({ slug: SLUG, day: D2, run: 151, parent: hidden, release: rel(3) });
    await w.one({ slug: "other", day: dayPlus(D0, -5), run: 7, release: rel(3), createdAt: "2026-11-12T00:00:00Z" });
    const r = (await lane(rel(3), [[SLUG, m]], { maxReleases: 2 })).coins[SLUG];
    expect(r.alerts).toEqual([{ code: "listing-too-shallow", count: 1 }]);
  });
});

describe("P8: a new coin has no floor either", () => {
  it("20 unpublished bundles over three releases, no main entry: the listing reaches the lowest release, the oldest 15 are adopted", async () => {
    const day0 = "2026-10-20";
    const chain = [];
    for (let n = 1; n <= 20; n++) chain.push(await w.one({ slug: SLUG, day: dayPlus(day0, n), run: 100 + n, parent: chain.at(-1), release: rel(Math.ceil(n / 7)) }));
    const out = await lane(rel(3), [[SLUG, null]]);
    const r = out.coins[SLUG];
    expect(out.listing).toMatchObject({ tags: [rel(3), rel(2), rel(1)], shallow: false });
    expect(r.chain).toEqual(chain.slice(0, 15).map((c) => c.entry));
    expect(r.alerts).toEqual([{ code: "too-long", count: 5 }]);
    expect((await acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: null, chain: r.chain })).status).toBe("accepted");
  });

  it("a new coin whose backlog is deeper than the maximum of releases: shallow, alerted", async () => {
    await w.one({ slug: SLUG, day: "2026-11-01", run: 1, release: rel(1) });
    await w.one({ slug: SLUG, day: "2026-11-02", run: 2, release: rel(2) });
    await w.one({ slug: SLUG, day: "2026-11-03", run: 3, release: rel(3) });
    const out = await lane(rel(3), [[SLUG, null]], { maxReleases: 2 });
    expect(out.listing.shallow).toBe(true);
    expect(alertOf(out.coins[SLUG], "listing-too-shallow")).toBeDefined();
  });
});

describe("item 3 (P2b): past the bound a drop needs a second look the same night", () => {
  async function two() {
    const m = await w.one({ slug: SLUG, day: D0, run: 100, release: rel(1) });
    const a = await w.one({ slug: SLUG, day: D1, run: 101, parent: m, release: TAG });
    const b = await w.one({ slug: SLUG, day: D2, run: 102, parent: a, release: TAG });
    return { m, a, b };
  }

  it("one failed header read of a pack 8 days old: the second look reads it, the chain is whole, nothing is alerted", async () => {
    const { m, a, b } = await two();
    const out = await lane(TAG, [[SLUG, m]], { blobs: flaky({ loc: b.packInfo.loc }) });
    expect(out.coins[SLUG].chain).toEqual([a.entry, b.entry]);
    expect(out.coins[SLUG].alerts).toEqual([]);
    expect(w.sleeps).toEqual([SECOND_LOOK_WAIT_MS]);
    expect(out.reads).toMatchObject({ secondLooks: 1, recovered: 1 });
  });

  it("a failed bundle read is given a second look too", async () => {
    const { m, a, b } = await two();
    const out = await lane(TAG, [[SLUG, m]], { blobs: flaky({ loc: b.packInfo.loc, from: b.packInfo.bodyStart }) });
    expect(out.coins[SLUG].chain).toEqual([a.entry, b.entry]);
    expect(out.coins[SLUG].alerts).toEqual([]);
    expect(out.reads).toMatchObject({ secondLooks: 1, recovered: 1 });
  });

  it("a failed item read is given a second look too", async () => {
    const { m, a, b } = await two();
    const at = b.packInfo.bodyStart + b.items.a.off;
    const out = await lane(TAG, [[SLUG, m]], { blobs: flaky({ loc: b.packInfo.loc, at }) });
    expect(out.coins[SLUG].chain).toEqual([a.entry, b.entry]);
    expect(out.coins[SLUG].alerts).toEqual([]);
    expect(out.reads).toMatchObject({ secondLooks: 1, recovered: 1 });
  });

  it("a persistent failure still drops the pack after the one second look", async () => {
    const { m, a, b } = await two();
    const out = await lane(TAG, [[SLUG, m]], { blobs: flaky({ loc: b.packInfo.loc, times: Infinity }) });
    expect(out.coins[SLUG].chain).toEqual([a.entry]);
    expect(out.coins[SLUG].alerts).toEqual([{ code: "unreadable-dropped", count: 1 }]);
    expect(w.sleeps).toEqual([SECOND_LOOK_WAIT_MS]);
    expect(out.reads).toMatchObject({ secondLooks: 1, recovered: 0 });
  });

  it("persistent failure of a bundle read and of an item read also drops after one wait for the pack", async () => {
    const { m, a, b } = await two();
    const bundle = await lane(TAG, [[SLUG, m]], { blobs: flaky({ loc: b.packInfo.loc, from: b.packInfo.bodyStart, times: Infinity }) });
    expect(bundle.coins[SLUG].chain).toEqual([a.entry]);
    expect(bundle.coins[SLUG].alerts).toEqual([{ code: "unreadable-dropped", count: 1 }]);
    const item = await lane(TAG, [[SLUG, m]], { blobs: flaky({ loc: b.packInfo.loc, at: b.packInfo.bodyStart + b.items.a.off, times: Infinity }) });
    expect(item.coins[SLUG].chain).toEqual([a.entry]);
    expect(item.coins[SLUG].alerts).toEqual([{ code: "unreadable-dropped", count: 1 }]);
  });

  it("P7: later faults on one pack each recover after their own wait; the wait is shared only when it ended moments ago", async () => {
    const { m, a, b } = await two();
    let t = NOW_MS;
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); t += ms; };
    const used = new Set();
    const once = (key) => !used.has(key) && used.add(key);
    const blobs = {
      ...w.blobs,
      readRange: async (loc, off, len) => {
        t += 10_000; // each read takes ten seconds, so a later fault is later than the share window
        if (loc === b.packInfo.loc && (off < b.packInfo.bodyStart ? once("header") : off === b.packInfo.bodyStart + b.items.bundle.off ? once("bundle") : off === b.packInfo.bodyStart + b.items.a.off && once("item"))) throw new StoreRangeError("short body after 3 attempts");
        return w.blobs.readRange(loc, off, len);
      },
    };
    const out = await lane(TAG, [[SLUG, m]], { blobs, sleep, now: () => t });
    expect(out.coins[SLUG].chain).toEqual([a.entry, b.entry]);
    expect(out.coins[SLUG].alerts).toEqual([]);
    expect(sleeps).toEqual([SECOND_LOOK_WAIT_MS, SECOND_LOOK_WAIT_MS, SECOND_LOOK_WAIT_MS]);
    expect(out.reads).toMatchObject({ secondLooks: 3, recovered: 3 });
    expect(SECOND_LOOK_SHARE_MS).toBeLessThan(SECOND_LOOK_WAIT_MS);
  });

  it("the wait is taken once for two coins of one pack", async () => {
    const mx = await w.one({ slug: "coin-x", day: D0, run: 100, lane: 0, release: rel(1) });
    const my = await w.one({ slug: "coin-y", day: D0, run: 100, lane: 1, release: rel(1) });
    const pack = await w.writePack({ day: D1, run: 101, release: TAG, coins: [{ slug: "coin-x", parent: mx }, { slug: "coin-y", parent: my }] });
    const out = await lane(TAG, [["coin-x", mx], ["coin-y", my]], { blobs: flaky({ loc: pack.loc, times: Infinity }) });
    for (const s of ["coin-x", "coin-y"]) expect(out.coins[s].alerts).toEqual([{ code: "unreadable-dropped", count: 1 }]);
    expect(w.sleeps).toEqual([SECOND_LOOK_WAIT_MS]);
    expect(out.reads).toMatchObject({ secondLooks: 1 });
  });

  it("inside the bound nothing changes: the coin fails tonight and no second look is taken", async () => {
    const m = await w.one({ slug: SLUG, day: D0, run: 100, release: rel(1) });
    const pack = await w.writePack({ day: D1, run: 101, release: TAG, coins: [{ slug: SLUG, parent: m }], createdAt: new Date(NOW_MS - 86400000).toISOString() });
    const out = await lane(TAG, [[SLUG, m]], { blobs: flaky({ loc: pack.loc, times: Infinity }) });
    expect(out.coins[SLUG].failed).toBe(true);
    expect(w.sleeps).toEqual([]);
    expect(out.reads).toMatchObject({ secondLooks: 0 });
  });

  it("the sleep is optional and defaults to a real wait of the named constant; a sleep that is not a function is refused", async () => {
    const { m, b } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { sleep, ...without } = w.listing;
      expect(sleep).toBeTypeOf("function");
      let done = false;
      const p = adoptLane({ blobs: flaky({ loc: b.packInfo.loc }), ...without, liveTag: TAG, kind: KIND, coins: [{ slug: SLUG, main: publishedOf(m) }] }).then((o) => { done = true; return o; });
      while (vi.getTimerCount() === 0) await new Promise((resolve) => { setImmediate(resolve); }); // the wait has started
      await vi.advanceTimersByTimeAsync(SECOND_LOOK_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).reads.recovered).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    await expect(lane(TAG, [], { sleep: "30" })).rejects.toThrow(AdoptionListingError);
  });
});

describe("item 4: a pack with no usable creation time is bounded by the day in its name", () => {
  const undated = (value) => async (tag) => {
    const got = await w.listRelease(tag);
    return { ...got, entries: got.entries.map((e) => ({ ...e, createdAt: value })) };
  };

  async function oneUnreadable({ mainDay, packDay }) {
    const m = await w.one({ slug: SLUG, day: mainDay, run: 100, release: rel(1) });
    const pack = await w.writePack({ day: packDay, run: 101, release: TAG, coins: [{ slug: SLUG, parent: m }] });
    return { m, pack };
  }

  for (const [label, value] of [["no creation time", undefined], ["a creation time in the future", "2027-01-01T00:00:00Z"], ["an unparsable creation time", "soon"]]) {
    it(`${label}, day in the name within the window: young, the coin fails and is told so`, async () => {
      const { m, pack } = await oneUnreadable({ mainDay: D0, packDay: D1 });
      const out = await lane(TAG, [[SLUG, m]], { listRelease: undated(value), blobs: flaky({ loc: pack.loc, times: Infinity }) });
      expect(out.coins[SLUG].failed).toBe(true);
      expect(out.coins[SLUG].alerts).toEqual([{ code: "unreadable", count: 1 }, { code: "unreadable-undated", count: 1 }]);
      expect(w.sleeps).toEqual([]);
    });

    it(`${label}, day in the name older than the adoption window: past the bound, second look, then dropped`, async () => {
      const { m, pack } = await oneUnreadable({ mainDay: "2026-10-20", packDay: "2026-10-25" });
      const out = await lane(TAG, [[SLUG, m]], { listRelease: undated(value), blobs: flaky({ loc: pack.loc, times: Infinity }) });
      expect(out.coins[SLUG].failed).toBe(false);
      expect(out.coins[SLUG].chain).toEqual([]);
      expect(out.coins[SLUG].alerts).toEqual([{ code: "unreadable-dropped", count: 1 }]);
      expect(w.sleeps).toEqual([SECOND_LOOK_WAIT_MS]);
      expect(why(out.coins[SLUG])).toMatch(/bad object/);
    });
  }
});
