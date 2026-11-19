import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW, createWorld, dayPlus, publishedOf } from "./adoptionKit.js";
import { adoptLane } from "./adoptionLane.js";
import { PackUnreadableError } from "./adoptionReads.js";
import { StoreHttpError, StoreNotFoundError, StoreRangeError } from "./blobStore.js";
import { UNREADABLE_PACK_DAYS } from "./storeConstants.js";

// Fix round 2: one pack that cannot be read tonight must not fail every coin of the lane, and
// must not hold a coin forever. A coin fails only when it cannot rule the pack out (a readable
// pack of the same kind, run id and attempt holds a bundle of that coin), and a pack that stays
// unreadable past UNREADABLE_PACK_DAYS is a bad object that is dropped with an alert.
const KIND = "holders";
const TAG = "data-live-2";
const D0 = "2026-11-10";
const D1 = dayPlus(D0, 1);
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86400000;
const BOUND_MS = UNREADABLE_PACK_DAYS * DAY_MS;
const ago = (ms) => new Date(NOW_MS - ms).toISOString();
const YOUNG = ago(DAY_MS); // a day old
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());

const failing = (blobs, locs, make, extra = {}) => ({
  ...blobs,
  ...extra,
  readRange: async (loc, off, len) => {
    if (locs.includes(loc)) throw make();
    return blobs.readRange(loc, off, len);
  },
});
const notFound = () => new StoreNotFoundError("not found: 404");
const mainOf = (slug, over = {}) => w.one({ slug, day: D0, run: 100, release: "data-live-1", ...over });
const run = (blobs, coins, over = {}) => adoptLane({ blobs, ...w.listing, liveTag: TAG, kind: KIND, coins: coins.map(([slug, main]) => ({ slug, main: main ? publishedOf(main) : null })), ...over });
const alertOf = (r, code) => r.alerts.find((a) => a.code === code);
const why = (r) => r.why.join("\n");

describe("item 1 and 2: an unreadable pack fails only the coins that cannot rule it out", () => {
  it("P4: coin-a ruled the pack out and adopts its chain, coin-b is untouched, only coin-c fails", async () => {
    const ma = await mainOf("coin-a", { lane: 0 });
    const mc = await mainOf("coin-c", { lane: 1 });
    const mb = await mainOf("coin-b", { day: D1, run: 90, lane: 2 });
    const a1 = await w.one({ slug: "coin-a", day: D1, run: 101, lane: 0, parent: ma, release: TAG });
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c", parent: mc }], createdAt: YOUNG });
    const out = await run(failing(w.blobs, [pack.loc], notFound), [["coin-a", ma], ["coin-b", mb], ["coin-c", mc]]);
    const [a, b, c] = ["coin-a", "coin-b", "coin-c"].map((s) => out.coins[s]);
    expect(a.failed).toBe(false);
    expect(a.chain).toEqual([a1.entry]);
    expect(why(a)).toMatch(/cannot be read/);
    expect(a.alerts).toEqual([]);
    expect(b.failed).toBe(false);
    expect(b.chain).toEqual([]);
    expect(b.start).toEqual({ source: "main", entry: publishedOf(mb), bundle: null });
    expect(c.failed).toBe(true);
    expect(c.chain).toBeNull();
    expect(c.start).toBeNull();
    expect(c.error).toBeInstanceOf(PackUnreadableError);
    expect(c.error.message).toContain(pack.loc);
    expect(c.alerts).toEqual([{ code: "unreadable", count: 1 }]);
  });

  it("a coin that cannot rule the pack out fails with the pack named, even with an unrelated chain of its own", async () => {
    const ma = await mainOf("coin-a");
    await w.one({ slug: "coin-a", day: D1, run: 102, parent: ma, release: TAG });
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c" }], createdAt: YOUNG });
    const out = await run(failing(w.blobs, [pack.loc], notFound), [["coin-a", ma]]);
    expect(out.coins["coin-a"].failed).toBe(true);
    expect(out.coins["coin-a"].error.message).toContain(pack.loc);
  });

  it("16 coins in 2 packs of one run attempt, one pack unreadable: 8 fail, 8 adopt, one header read per pack", async () => {
    const slugs = Array.from({ length: 16 }, (_, i) => `coin-${String(i).padStart(2, "0")}`);
    const mains = {};
    for (const [i, s] of slugs.entries()) mains[s] = await mainOf(s, { lane: i });
    const packs = [];
    for (const lane of [0, 1]) {
      const group = slugs.slice(lane * 8, lane * 8 + 8);
      packs.push(await w.writePack({ day: D1, run: 201, lane, release: TAG, coins: group.map((slug) => ({ slug, parent: mains[slug] })), createdAt: YOUNG }));
    }
    const out = await run(failing(w.blobs, [packs[1].loc], notFound), slugs.map((s) => [s, mains[s]]));
    const failed = slugs.filter((s) => out.coins[s].failed);
    expect(failed).toEqual(slugs.slice(8));
    for (const s of slugs.slice(0, 8)) expect(out.coins[s].chain).toEqual([packs[0].coins[s].entry]);
    expect(out.coins[slugs[8]].error).toBeInstanceOf(PackUnreadableError);
    expect(out.reads).toMatchObject({ headerReads: 2, bundleReads: 16, confirmations: 1 }); // a header read and a bundle read for each of the 8
  });

  it("two readable packs of one run attempt holding a bundle of the same coin: alert, and nothing is ruled out for it", async () => {
    const mx = await mainOf("coin-x");
    const one = await w.one({ slug: "coin-x", day: D1, run: 301, lane: 0, parent: mx, release: TAG });
    const pack = await w.writePack({ day: D1, run: 301, lane: 2, release: TAG, coins: [{ slug: "coin-y" }], createdAt: YOUNG });
    const blobs = failing(w.blobs, [pack.loc], notFound);
    let out = await run(blobs, [["coin-x", mx]]);
    expect(out.coins["coin-x"].failed).toBe(false);
    expect(out.coins["coin-x"].chain).toEqual([one.entry]);
    await w.one({ slug: "coin-x", day: D1, run: 301, lane: 1, parent: mx, release: TAG });
    out = await run(blobs, [["coin-x", mx]]);
    const x = out.coins["coin-x"];
    expect(x.failed).toBe(true);
    expect(x.alerts).toEqual([{ code: "run-wrote-coin-twice", count: 1 }, { code: "unreadable", count: 1 }]);
    expect(why(x)).toMatch(/wrote two readable packs/);
  });

  it("a pack of another run attempt does not rule an unreadable pack out", async () => {
    const mx = await mainOf("coin-x");
    await w.one({ slug: "coin-x", day: D1, run: 301, attempt: 2, lane: 0, parent: mx, release: TAG });
    const pack = await w.writePack({ day: D1, run: 301, attempt: 1, lane: 2, release: TAG, coins: [{ slug: "coin-y" }], createdAt: YOUNG });
    const out = await run(failing(w.blobs, [pack.loc], notFound), [["coin-x", mx]]);
    expect(out.coins["coin-x"].failed).toBe(true);
  });

  it("a Range failure of the header is an unreadable pack too, and the lane goes on", async () => {
    const m = await mainOf("coin-a");
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c" }], createdAt: YOUNG });
    const out = await run(failing(w.blobs, [pack.loc], () => new StoreRangeError("short body after 3 attempts")), [["coin-a", m]]);
    expect(out.coins["coin-a"].failed).toBe(true);
    expect(out.coins["coin-a"].error.cause).toBeInstanceOf(StoreRangeError);
    expect(out.reads.confirmations).toBe(0);
  });

  it("a failure to read a bundle fails that coin only, with its own error and an alert", async () => {
    const ma = await mainOf("coin-a", { lane: 0 });
    const mb = await mainOf("coin-b", { lane: 1 });
    const a1 = await w.one({ slug: "coin-a", day: D1, run: 101, lane: 0, parent: ma, release: TAG });
    const b1 = await w.one({ slug: "coin-b", day: D1, run: 102, lane: 1, parent: mb, release: TAG });
    const blobs = { ...w.blobs, readRange: async (loc, off, len) => { if (loc === a1.packInfo.loc && off > 0) throw new StoreHttpError("502"); return w.blobs.readRange(loc, off, len); } };
    const out = await run(blobs, [["coin-a", ma], ["coin-b", mb]]);
    expect(out.coins["coin-a"].failed).toBe(true);
    expect(out.coins["coin-a"].error).toBeInstanceOf(StoreHttpError);
    expect(out.coins["coin-a"].alerts).toEqual([{ code: "read-failed", count: 1 }]);
    expect(out.coins["coin-b"].chain).toEqual([b1.entry]);
  });

  it("a programming error (TypeError, ReferenceError, RangeError) still stops the lane", async () => {
    const m = await mainOf("coin-a");
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c" }], createdAt: YOUNG });
    for (const make of [() => new TypeError("x"), () => new ReferenceError("x"), () => new RangeError("x")]) {
      await expect(run(failing(w.blobs, [pack.loc], make), [["coin-a", m]])).rejects.toThrow(make().constructor);
    }
  });
});

describe("item 2: a not-found is confirmed with stat before the pack is called unreadable", () => {
  it("stat finds nothing: the pack is gone, a bad object, dropped with a damaged alert; the coin goes on", async () => {
    const m = await mainOf("coin-c");
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c" }], createdAt: YOUNG });
    const blobs = failing(w.blobs, [pack.loc], notFound, { stat: async (loc) => (loc === pack.loc ? null : w.blobs.stat(loc)) });
    const out = await run(blobs, [["coin-c", m]]);
    const c = out.coins["coin-c"];
    expect(c.failed).toBe(false);
    expect(c.chain).toEqual([]);
    expect(alertOf(c, "damaged")).toEqual({ code: "damaged", count: 1 });
    expect(out.reads.confirmations).toBe(1);
  });
});

describe("item 3: an unreadable pack is transient only while it is younger than the bound", () => {
  const setup = async (createdAt, makeBlobs = (loc) => failing(w.blobs, [loc], notFound)) => {
    const m = await mainOf("coin-c");
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c" }], createdAt });
    return { m, pack, out: await run(makeBlobs(pack.loc), [["coin-c", m]]) };
  };

  it("the bound is three days", () => {
    expect(UNREADABLE_PACK_DAYS).toBe(3);
  });

  it("one millisecond inside the bound: the coin fails tonight", async () => {
    const { out } = await setup(ago(BOUND_MS - 1));
    expect(out.coins["coin-c"].failed).toBe(true);
    expect(alertOf(out.coins["coin-c"], "unreadable")).toEqual({ code: "unreadable", count: 1 });
  });

  it("at the bound: a bad object, dropped with the alert unreadable-dropped; the coin goes on from its main entry", async () => {
    const { m, out } = await setup(ago(BOUND_MS));
    const c = out.coins["coin-c"];
    expect(c.failed).toBe(false);
    expect(c.chain).toEqual([]);
    expect(c.start).toEqual({ source: "main", entry: publishedOf(m), bundle: null });
    expect(c.alerts).toEqual([{ code: "unreadable-dropped", count: 1 }]);
    expect(why(c)).toMatch(/3 days old or older/);
  });

  it("past the bound, a coin whose bundles are elsewhere adopts them", async () => {
    const m = await mainOf("coin-c");
    const good = await w.one({ slug: "coin-c", day: D1, run: 102, lane: 0, parent: m, release: TAG });
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-d" }], createdAt: ago(BOUND_MS + DAY_MS) });
    const out = await run(failing(w.blobs, [pack.loc], notFound), [["coin-c", m]]);
    expect(out.coins["coin-c"].chain).toEqual([good.entry]);
  });

  it("a pack with no creation time is treated as young, and alerted", async () => {
    const m = await mainOf("coin-c");
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c" }], createdAt: ago(BOUND_MS * 5) });
    const bare = async (tag) => {
      const got = await w.listRelease(tag);
      return { ...got, entries: got.entries.map(({ createdAt, ...rest }) => rest) };
    };
    const out = await run(failing(w.blobs, [pack.loc], notFound), [["coin-c", m]], { listRelease: bare });
    const c = out.coins["coin-c"];
    expect(c.failed).toBe(true);
    expect(c.alerts).toEqual([{ code: "unreadable", count: 1 }, { code: "unreadable-undated", count: 1 }]);
  });

  it("only a failure of that pack's own bytes ages out: a rate limit or HTTP error never does", async () => {
    const m = await mainOf("coin-c");
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-c" }], createdAt: ago(BOUND_MS * 5) });
    const out = await run(failing(w.blobs, [pack.loc], () => new StoreHttpError("503")), [["coin-c", m]]);
    expect(out.coins["coin-c"].failed).toBe(true);
  });
});

describe("item 3: a carried item whose pack stat answers for but cannot be read", () => {
  // The main entry's pack is in data-live-1, outside the two releases listed; the first bundle
  // carries its base. stat gives no creation time, so the age is that of the carrying bundle's pack.
  const setup = async (carrierCreatedAt, over = {}) => {
    const m = await mainOf("coin-a");
    await w.one({ slug: "coin-a", day: D1, run: 101, parent: m, release: "data-live-3", createdAt: carrierCreatedAt });
    const out = await adoptLane({ blobs: failing(w.blobs, [m.packInfo.loc], notFound), ...w.listing, ...over, liveTag: "data-live-3", maxReleases: 2, kind: KIND, coins: [{ slug: "coin-a", main: publishedOf(m) }] });
    return { m, out: out.coins["coin-a"] };
  };

  it("inside the bound: the coin fails tonight with an alert, every night it fails", async () => {
    const { m, out } = await setup(ago(BOUND_MS - 1));
    expect(out.failed).toBe(true);
    expect(out.error).toBeInstanceOf(PackUnreadableError);
    expect(out.error.message).toContain(m.packInfo.loc);
    expect(alertOf(out, "unreadable")).toEqual({ code: "unreadable", count: 1 });
  });

  it("at the bound: the bundle that carries it is dropped with an alert, and the coin goes on", async () => {
    const { out } = await setup(ago(BOUND_MS));
    expect(out.failed).toBe(false);
    expect(out.chain).toEqual([]);
    expect(alertOf(out, "unreadable-dropped")).toEqual({ code: "unreadable-dropped", count: 1 });
  });

  it("the carrying pack has no creation time: young, and alerted", async () => {
    const bare = async (tag) => {
      const got = await w.listRelease(tag);
      return { ...got, entries: got.entries.map(({ createdAt, ...rest }) => rest) };
    };
    const { out } = await setup(ago(BOUND_MS * 5), { listRelease: bare });
    expect(out.failed).toBe(true);
    expect(alertOf(out, "unreadable-undated")).toEqual({ code: "unreadable-undated", count: 1 });
  });
});

describe("the lane keeps what it had", () => {
  it("one header read per pack for the lane, whichever coins ask", async () => {
    const mains = [await mainOf("coin-a", { lane: 0 }), await mainOf("coin-b", { lane: 1 })];
    const pack = await w.writePack({ day: D1, run: 101, lane: 5, release: TAG, coins: [{ slug: "coin-z" }], createdAt: YOUNG });
    const out = await run(failing(w.blobs, [pack.loc], notFound), [["coin-a", mains[0]], ["coin-b", mains[1]]]);
    expect(out.reads.headerReads).toBe(1);
    expect(out.reads.confirmations).toBe(1);
  });
});

describe("the blind spot of the ruling-out rule: a parent that lies in the unreadable pack", () => {
  // The same pack name in two releases (a crash and rerun): the copy in data-live-1 is readable,
  // the original in data-live-2 is not, and a child bundle names the original's bundle as parent.
  const setup = async (createdAt) => {
    const m = await mainOf("coin-x");
    const original = await w.writePack({ day: D1, run: 101, release: TAG, coins: [{ slug: "coin-x", parent: m }], createdAt, salt: "original" });
    const copy = await w.writePack({ day: D1, run: 101, release: "data-live-1", coins: [{ slug: "coin-x", parent: m }], createdAt: YOUNG, salt: "copy" });
    await w.one({ slug: "coin-x", day: dayPlus(D0, 2), run: 102, parent: original.coins["coin-x"], release: TAG });
    const out = await run(failing(w.blobs, [original.loc], notFound), [["coin-x", m]]);
    return { original, copy, x: out.coins["coin-x"] };
  };

  it("inside the bound the coin fails tonight; it does not return the shorter chain through the copy", async () => {
    const { original, x } = await setup(YOUNG);
    expect(x.failed).toBe(true);
    expect(x.chain).toBeNull();
    expect(x.error.message).toContain(original.loc);
    expect(alertOf(x, "unreadable")).toEqual({ code: "unreadable", count: 1 });
  });

  it("past the bound the pack is dropped, and the coin has the chain of the readable world", async () => {
    const { copy, x } = await setup(ago(BOUND_MS));
    expect(x.failed).toBe(false);
    expect(x.chain).toEqual([copy.coins["coin-x"].entry]);
    expect(alertOf(x, "unreadable-dropped")).toEqual({ code: "unreadable-dropped", count: 1 });
  });
});

describe("item 2: a failure of the bytes of a pack whose header read fine", () => {
  const stages = [
    ["a bundle read", (rec) => (loc, off) => loc === rec.packInfo.loc && off === rec.packInfo.bodyStart + rec.items.bundle.off],
    ["an item read", (rec) => (loc, off) => loc === rec.packInfo.loc && off === rec.packInfo.bodyStart + rec.items.base.off],
  ];
  const setup = async (createdAt, when, make) => {
    const m = await mainOf("coin-a");
    const a1 = await w.one({ slug: "coin-a", day: D1, run: 101, parent: m, release: TAG, createdAt });
    const blobs = { ...w.blobs, readRange: async (loc, off, len) => { if (when(a1)(loc, off)) throw make(); return w.blobs.readRange(loc, off, len); } };
    return (await run(blobs, [["coin-a", m]])).coins["coin-a"];
  };
  const ageable = [["not found though stat answers", notFound], ["a range failure", () => new StoreRangeError("short body after 3 attempts")]];
  for (const [stage, when] of stages) {
    for (const [cause, make] of ageable) {
      it(`${cause} at ${stage}: inside the bound the coin fails`, async () => {
        const r = await setup(ago(BOUND_MS - 1), when, make);
        expect(r.failed).toBe(true);
        expect(r.error).toBeInstanceOf(PackUnreadableError);
        expect(alertOf(r, "unreadable")).toEqual({ code: "unreadable", count: 1 });
      });
      it(`${cause} at ${stage}: at the bound the bundle is dropped with unreadable-dropped`, async () => {
        const r = await setup(ago(BOUND_MS), when, make);
        expect(r.failed).toBe(false);
        expect(r.chain).toEqual([]);
        expect(alertOf(r, "unreadable-dropped")).toEqual({ code: "unreadable-dropped", count: 1 });
      });
    }
    it(`an HTTP error at ${stage} never ages out`, async () => {
      const r = await setup(ago(BOUND_MS * 5), when, () => new StoreHttpError("503"));
      expect(r.failed).toBe(true);
      expect(r.alerts).toEqual([{ code: "read-failed", count: 1 }]);
    });
  }
});
