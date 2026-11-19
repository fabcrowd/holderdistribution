// Release backend only: the fields of a created release, request costs, roll-over against
// the fake's hard limit of 1,000 assets, reads by location that never list, the digest
// and read-back identity checks, and every fault switch at every request index.
import { describe, it, expect } from "vitest";
import { memorySink, StoreError, StoreNameTakenError, BUDGET } from "./blobStore.js";
import { releaseBackend } from "./blobStoreRelease.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { folderBackend } from "./blobStoreFolder.js";
import { createFakeReleaseServer, FAULT_TYPES, SEED_MADE_AT } from "./fakeReleaseServer.js";
import { packName, releaseTag } from "./packNames.js";
import { genBytes } from "./pack.test.js";

const T = 60000;
const live = (flush, lane = 0, run = 9) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run, attempt: 1, lane, flush });

function backendOn(server, opts = {}) {
  return releaseBackend({ owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t, sleep: async (ms) => { server.clock.t += ms; }, assetLimit: 5, ...opts });
}

describe("release backend specifics", () => {
  it("creates prereleases with the fields of section 7.1 and never sends the token to the signed host", async () => {
    const server = createFakeReleaseServer();
    const store = backendOn(server);
    const { loc } = await store.upload(live(0), genBytes(100));
    expect(server.release("data-live-1")).toMatchObject({ prerelease: true, make_latest: "false" });
    expect(JSON.parse(server.release("data-live-1").body)).toMatchObject({ schema: 1, note: "Generated data, written by the pipeline; do not edit or delete by hand" });
    expect((await store.readRange(loc, 0, 5)).length).toBe(5); // the fake answers 400 if the token reaches it
  });

  it("costs without faults: upload 3 core (count + upload), delete 1, reads by location 0", async () => {
    const store = backendOn(createFakeReleaseServer());
    await store.upload(live(0), genBytes(10));
    let c = store.stats().core;
    const { loc } = await store.upload(live(1), genBytes(10));
    expect(store.stats().core - c).toBe(3);
    await store.list("live");
    c = store.stats().core;
    await store.readRange(loc, 0, 5);
    await store.download(loc, memorySink());
    await store.stat(loc);
    expect(store.stats().core - c).toBe(0);
    await store.delete(loc);
    expect(store.stats().core - c).toBe(1);
  });

  it("M1: a refusal that is not a 422 is surfaced with its real status, never as full", async () => {
    const server = createFakeReleaseServer();
    const store = backendOn(server);
    await store.upload(live(0), genBytes(10));
    const http = server.http;
    const refusing = backendOn({ ...server, http: (url, init) => (String(url).startsWith("https://uploads.") ? Promise.resolve(new Response("{}", { status: 400 })) : http(url, init)) });
    await expect(refusing.upload(live(1), genBytes(10))).rejects.toThrow(/unexpected status 400/);
  });

  it("100 reads by location against 50 releases cost 0 core requests", async () => {
    const server = createFakeReleaseServer();
    for (let s = 1; s <= 50; s++) server.seed(releaseTag("live", s), 3, (i) => live(i, s));
    const store = backendOn(server);
    const before = store.stats().core;
    for (let i = 0; i < 100; i++) {
      const s = 1 + (i % 50);
      expect((await store.readRange(`${releaseTag("live", s)}/${live(i % 3, s)}`, 0, 1))[0]).toBe(i % 3);
    }
    expect(store.stats().core - before).toBe(0);
  });

  it("100 find calls on absent names cost one series listing, not 100; exists by location costs 0", async () => {
    const server = createFakeReleaseServer();
    for (let s = 1; s <= 50; s++) server.seed(releaseTag("live", s), 3, (i) => live(i, s));
    const store = backendOn(server);
    for (let i = 0; i < 100; i++) expect(await store.find(live(i, 0, 77))).toEqual([]);
    const one = store.stats().core;
    expect(one).toBeLessThanOrEqual(BUDGET.listSeries(50, 50));
    expect(server.counts.listReleases).toBeLessThanOrEqual(3); // one listing: two counts and one page
    for (let i = 0; i < 100; i++) expect(await store.exists(`data-live-1/${live(i, 0, 77)}`)).toBe(false);
    expect(store.stats().core).toBe(one);
    store.refresh("live");
    await store.find(live(0, 0, 77));
    expect(store.stats().core).toBeGreaterThan(one); // an explicit refresh lists again
  });

  it("R4: 34 lanes uploading 3 kinds each into a release seeded with 899: 0 failures, none over 1,000", async () => {
    const server = createFakeReleaseServer();
    server.seed(releaseTag("live", 1), 899, (i) => live(i, 99, 1));
    const kinds = ["holders", "ledger", "walletFlows"];
    const name = (lane, kind) => packName({ cls: "live", kind, day: "2026-11-18", run: 1, attempt: 1, lane, flush: 0 });
    const results = await Promise.allSettled(Array.from({ length: 34 }, (_, lane) => {
      const s = backendOn(server, { assetLimit: 900 });
      return Promise.all(kinds.map((k) => s.upload(name(lane, k), Buffer.from(`${lane}${k}`))));
    }));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const counts = server.releases.map((r) => r.assets.length);
    expect(counts.reduce((a, b) => a + b)).toBe(899 + 102);
    for (const n of counts) expect(n).toBeLessThanOrEqual(1000);
    expect(counts[0]).toBeLessThanOrEqual(900 + 34 - 1);
  }, T);

  it("12 lanes of 20 packs against the fake's 1,000: every upload succeeds, no release over 1,000", async () => {
    const server = createFakeReleaseServer();
    server.seed(releaseTag("live", 1), 890, (i) => live(i, 99, 1));
    const lanes = Array.from({ length: 12 }, () => backendOn(server, { assetLimit: 900 }));
    await Promise.all(lanes.map(async (s, lane) => {
      for (let f = 0; f < 20; f++) await s.upload(live(f, lane), genBytes(8, lane * 100 + f));
    }));
    const counts = server.releases.map((r) => r.assets.length);
    expect(counts.reduce((a, b) => a + b)).toBe(890 + 240);
    for (const n of counts) expect(n).toBeLessThanOrEqual(1000);
    expect(counts[0]).toBeLessThanOrEqual(900 + 12 - 1);
  }, T);

  it("a refused upload at the hard limit re-counts and rolls over", async () => {
    const server = createFakeReleaseServer({ hardLimit: 3 });
    const store = backendOn(server, { assetLimit: 900 }); // the local limit never triggers
    for (let f = 0; f < 3; f++) await store.upload(live(f), genBytes(8, f));
    await expect(store.upload(live(3), genBytes(8, 3))).rejects.toThrow(/unexpected status 422/);
    // Two lanes count 2 of 3 at once; the second post is refused, re-counts 3 and rolls.
    const tight = createFakeReleaseServer({ hardLimit: 3 });
    tight.seed(releaseTag("live", 1), 2, (i) => live(i, 50));
    const locs = await Promise.all([0, 1].map((lane) => backendOn(tight, { assetLimit: 3 }).upload(live(0, lane), genBytes(8, lane)).then((r) => r.loc)));
    expect(locs.map((l) => l.split("/")[0]).sort()).toEqual(["data-live-1", "data-live-2"]);
    expect(tight.release("data-live-1").assets).toHaveLength(3);
  });

  it("a full release that GitHub refuses with 400 instead of 422 rolls over and the upload succeeds", async () => {
    // Two lanes count 2 of 3 at once; the second post is refused with 400, re-counts 3 and rolls.
    const server = createFakeReleaseServer({ hardLimit: 3, hardLimitStatus: 400 });
    server.seed(releaseTag("live", 1), 2, (i) => live(i, 50));
    const locs = await Promise.all([0, 1].map((lane) => backendOn(server, { assetLimit: 3 }).upload(live(0, lane), genBytes(8, lane)).then((r) => r.loc)));
    expect(locs.map((l) => l.split("/")[0]).sort()).toEqual(["data-live-1", "data-live-2"]);
    expect(server.release("data-live-1").assets).toHaveLength(3);
  });

  it("an unrelated 400 on a full release rolls over once and surfaces with its real status from the next release", async () => {
    const server = createFakeReleaseServer();
    server.seed(releaseTag("live", 1), 4, (i) => live(i, 50));
    const http = server.http;
    const posts = [];
    const refusing = backendOn({ ...server, http: (url, init) => {
      if (!String(url).startsWith("https://uploads.")) return http(url, init);
      posts.push(String(url));
      // Another process fills release 1 between the count and this post.
      if (posts.length === 1) server.seed(releaseTag("live", 1), 1, (i) => live(i, 51));
      return Promise.resolve(new Response("{}", { status: 400 }));
    } });
    await expect(refusing.upload(live(0), genBytes(10))).rejects.toThrow(/unexpected status 400/);
    expect(posts).toHaveLength(2);
    expect(server.release("data-live-2")).toBeTruthy();
  });

  it("without a digest, identity is checked by reading the asset back (0 core requests for the read)", async () => {
    const server = createFakeReleaseServer({ digests: false });
    const a = backendOn(server);
    await a.upload(live(0), Buffer.from("same"));
    expect((await backendOn(server).upload(live(0), Buffer.from("same"))).size).toBe(4);
    await expect(backendOn(server).upload(live(0), Buffer.from("diff"))).rejects.toBeInstanceOf(StoreNameTakenError);
    expect(server.asset(live(0)).bytes.toString()).toBe("same");
  });

  it("a rate limit that outlasts the bound fails with a named error and no token in it", async () => {
    const server = createFakeReleaseServer();
    const store = backendOn(server, { maxRateWaitMs: 1000 });
    server.failAt(0, "rate403");
    const err = await store.upload(live(0), genBytes(10)).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.name).toBe("StoreRateLimitError");
    expect(String(err.message) + String(err.stack)).not.toContain("secret-token");
  });
});

// Every fault at every request index of each operation, on a fresh server each time.
async function seeded() {
  const server = createFakeReleaseServer({ perPage: 3 });
  const setup = backendOn(server);
  const { loc } = await setup.upload(live(0), genBytes(4000, 1));
  for (let f = 10; f < 16; f++) await setup.upload(live(f), genBytes(10, f));
  const store = backendOn(server);
  await store.list("live"); // a lane lists before it works, so names are cached
  return { server, store, loc };
}

const OPS = {
  async upload({ store, server }) {
    const bytes = genBytes(3000, 7);
    let ok = false;
    try {
      await store.upload(live(3), bytes);
      ok = true;
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
    }
    server.clearFaults();
    expect(server.assetCount(live(3))).toBeLessThanOrEqual(1);
    if (ok) expect(server.asset(live(3))).toMatchObject({ state: "uploaded", bytes });
    // never lost: a second call after a failure leaves exactly one good asset
    await store.upload(live(3), bytes);
    expect(server.assetCount(live(3))).toBe(1);
    expect(server.asset(live(3)).bytes.equals(bytes)).toBe(true);
    return 2 * BUDGET.upload;
  },
  async readRange({ store, loc }) {
    try {
      expect((await store.readRange(loc, 100, 300)).equals(genBytes(4000, 1).subarray(100, 400))).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
    }
    return BUDGET.readRange;
  },
  async download({ store, loc }) {
    const sink = memorySink();
    try {
      await store.download(loc, sink, { rangeBytes: 1000, parallel: 3 });
      expect(sink.bytes().equals(genBytes(4000, 1))).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
    }
    return BUDGET.download;
  },
  async list({ store, server }) {
    try {
      const got = await store.list("live");
      expect(got.map((x) => x.name).sort()).toEqual(server.releases.flatMap((r) => r.assets.map((a) => a.name)).sort());
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
    }
    return BUDGET.listSeries(2, 2);
  },
  async delete({ store, server, loc }) {
    try {
      await store.delete(loc);
      expect(server.assetCount(live(0))).toBe(0);
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
    }
    return BUDGET.delete;
  },
};

describe("release backend under faults", () => {
  for (const [op, run] of Object.entries(OPS)) {
    it(`${op}: every fault at every request index`, async () => {
      for (const type of [...FAULT_TYPES, "storeThenFail", "storePartial", "truncate", "badRange", "shiftListing"]) {
        for (let at = 0; at < 8; at++) {
          const ctx = await seeded();
          ctx.server.failAt(at, type);
          const before = ctx.store.stats().core;
          const budget = await run(ctx).catch((e) => { throw new Error(`${type} @${at}: ${e.message}`); });
          expect(ctx.store.stats().core - before, `${op} ${type} @${at}`).toBeLessThanOrEqual(budget);
        }
      }
    }, T);
  }
});

describe("releasesOf and deleteRelease on the release backend (A3)", () => {
  it("releasesOf costs nothing after the series was listed; deleteRelease costs a count and a delete", async () => {
    const server = createFakeReleaseServer();
    server.seed("data-live-1", 2, (i) => live(i));
    server.seed("data-live-2", 0, () => "unused");
    const store = backendOn(server);
    await store.list("live");
    const c = store.stats().core;
    expect(await store.releasesOf("live")).toEqual([
      { tag: "data-live-1", seq: 1, assets: 2, createdAt: new Date(SEED_MADE_AT).toISOString() }, { tag: "data-live-2", seq: 2, assets: 0, createdAt: new Date(SEED_MADE_AT).toISOString() },
    ]); // the creation time is the instant in the release record
    expect(store.stats().core).toBe(c);
    await store.deleteRelease("data-live-2");
    expect(store.stats().core - c).toBeLessThanOrEqual(BUDGET.deleteRelease);
    expect(server.counts.deleteRelease).toBe(1);
    expect(server.release("data-live-2")).toBe(null);
  });

  it("never deletes a release that holds an asset, although the server would delete it with its assets", async () => {
    const server = createFakeReleaseServer();
    server.seed("data-live-1", 1, () => live(0));
    const store = backendOn(server);
    await store.list("live"); // the cached listing may be stale: the count is read fresh
    server.seed("data-live-2", 0, () => "unused");
    await store.list("live");
    server.seed("data-live-2", 1, () => live(5)); // an upload from another process lands after the listing
    await expect(store.deleteRelease("data-live-2")).rejects.toThrow(/still holds 1 asset/);
    expect(server.counts.deleteRelease ?? 0).toBe(0);
    expect(server.release("data-live-2").assets).toHaveLength(1);
  });

  it("an upload after the release was deleted goes to the next number, never the deleted one, and does not look for a name posted there before", async () => {
    const server = createFakeReleaseServer();
    const store = backendOn(server);
    const up = await store.upload(live(0), genBytes(10));
    await store.delete(up.loc);
    await store.deleteRelease("data-live-1");
    expect((await store.upload(live(0), genBytes(10))).loc).toBe(`data-live-2/${live(0)}`);
    expect(server.release("data-live-1")).toBe(null);
  });
});

// Uploads go only to the newest existing release of a series, or a newer one (target()).
describe("the uploader never goes back to an older release (A3 fix)", () => {
  const tagOf = (up) => up.loc.slice(0, up.loc.indexOf("/"));
  // limit 3: data-live-1 is full, data-live-2 holds `inSecond` assets, and a slot is then freed in data-live-1.
  async function twoReleases(inSecond) {
    const server = createFakeReleaseServer();
    const a = backendOn(server, { assetLimit: 3 });
    for (let i = 0; i < 3 + inSecond; i++) await a.upload(live(i), genBytes(5, i));
    await a.delete(`data-live-1/${live(0)}`);
    return server;
  }

  it("a fresh backend with no seqs and one with a stale seqs upload into the newest release, not the first with room", async () => {
    for (const opts of [{}, { seqs: { live: 1 } }]) {
      const server = await twoReleases(1);
      const up = await backendOn(server, { assetLimit: 3, ...opts }).upload(live(50), genBytes(5));
      expect(tagOf(up), JSON.stringify(opts)).toBe("data-live-2");
    }
  });

  it("when the newest is full they go one higher, never into the freed slot of the first", async () => {
    for (const opts of [{}, { seqs: { live: 1 } }]) {
      const server = await twoReleases(3);
      const up = await backendOn(server, { assetLimit: 3, ...opts }).upload(live(50), genBytes(5));
      expect(tagOf(up), JSON.stringify(opts)).toBe("data-live-3");
    }
  });

  it("seqs higher than every existing release starts there; a series with no release starts at 1", async () => {
    const server = await twoReleases(1);
    expect(tagOf(await backendOn(server, { assetLimit: 3, seqs: { live: 7 } }).upload(live(50), genBytes(5)))).toBe("data-live-7");
    expect(tagOf(await backendOn(createFakeReleaseServer()).upload(live(1), genBytes(5)))).toBe("data-live-1");
  });

  it("a release held as current that another process deleted: the uploader finds the newest again and never re-creates the number", async () => {
    const server = createFakeReleaseServer();
    const a = backendOn(server, { assetLimit: 3 });
    for (let i = 0; i < 4; i++) await a.upload(live(i), genBytes(5, i)); // live-1 full, live-2 holds 1: a's current is 2
    server.releases.splice(server.releases.findIndex((r) => r.tag_name === "data-live-2"), 1); // deleted under it
    const up = await a.upload(live(60), genBytes(5));
    expect(tagOf(up)).toBe("data-live-3"); // live-1 is full; 2 is never made again
    expect(server.release("data-live-2")).toBe(null);
  });

  it("the same, when the deleted release was the only one: it continues one higher", async () => {
    const server = createFakeReleaseServer();
    const a = backendOn(server, { assetLimit: 3 });
    await a.upload(live(0), genBytes(5));
    server.releases.length = 0;
    expect(tagOf(await a.upload(live(1), genBytes(5)))).toBe("data-live-2");
    expect(server.release("data-live-1")).toBe(null);
  });

  it("when the newest is deleted the uploader goes above every number it saw, not to an older release with room", async () => {
    const server = createFakeReleaseServer();
    const a = backendOn(server, { assetLimit: 3 });
    for (let i = 0; i < 4; i++) await a.upload(live(i), genBytes(5, i));
    await a.delete(`data-live-1/${live(0)}`);
    server.releases.splice(server.releases.findIndex((r) => r.tag_name === "data-live-2"), 1);
    expect(tagOf(await a.upload(live(60), genBytes(5)))).toBe("data-live-3");
  });

  it("two backends on one server: the one with a cached current rolls over and keeps to the rules", async () => {
    const server = createFakeReleaseServer();
    const a = backendOn(server, { assetLimit: 2 });
    const b = backendOn(server, { assetLimit: 2 });
    await a.upload(live(0), genBytes(5));
    await a.upload(live(1), genBytes(5)); // data-live-1 full, a caches current = 1
    expect(tagOf(await b.upload(live(2), genBytes(5)))).toBe("data-live-2"); // b starts at the newest with room: 2
    expect(tagOf(await a.upload(live(3), genBytes(5)))).toBe("data-live-2"); // a rolls over to the release that exists
    await a.delete(`data-live-1/${live(0)}`); // a slot is freed behind both of them
    expect(tagOf(await a.upload(live(4), genBytes(5)))).toBe("data-live-3"); // 2 is full now: one higher, never back
    expect(tagOf(await b.upload(live(5), genBytes(5)))).toBe("data-live-3");
  });

  it("costs: the first upload of a process into a series adds one release listing; later uploads cost 3 core requests", async () => {
    const server = createFakeReleaseServer();
    server.seed("data-live-1", 1, () => live(0));
    server.seed("data-hist-1", 1, () => "x");
    const store = backendOn(server);
    let c = store.stats().core;
    await store.upload(live(1), genBytes(5));
    expect(store.stats().core - c).toBe(3 + 3); // release listing (count, page, count) + count + upload
    expect(store.stats().core - c).toBeLessThanOrEqual(3 + BUDGET.newestRelease(2));
    c = store.stats().core;
    await store.upload(live(2), genBytes(5));
    expect(store.stats().core - c).toBe(3);
    expect(server.counts.listReleases).toBe(3); // one listing for the whole process and series
  });

  it("the folder backend follows the same rule: the newest subfolder, never back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "newest-"));
    const mk = () => folderBackend(dir, { assetLimit: 2 });
    for (let i = 0; i < 5; i++) await mk().upload(live(i), genBytes(5, i)); // 1: 2, 2: 2, 3: 1
    await mk().delete(`data-live-1/${live(0)}`);
    expect(tagOf(await mk().upload(live(9), genBytes(5)))).toBe("data-live-3");
    expect(tagOf(await mk().upload(live(10), genBytes(5)))).toBe("data-live-4");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 19, 12);
const startedAt = () => createFakeReleaseServer({ clock: { t: T0 } });
const goneTag = (server, tag) => server.releases.splice(server.releases.findIndex((r) => r.tag_name === tag), 1);

// The age of a release comes from the record its creator wrote, never from created_at (A3 fix, round 4).
describe("the creation instant of a release is the one its creator recorded", () => {
  it("a release this backend creates carries its own clock's instant; the server's old created_at is not used", async () => {
    const server = startedAt();
    const store = backendOn(server);
    await store.upload(live(0), genBytes(5));
    const [r] = await store.releasesOf("live");
    expect(r.createdAt).toBe(new Date(T0).toISOString());
    expect(server.release("data-live-1").created_at).toBe("2019-06-01T00:00:00.000Z");
    expect(JSON.parse(server.release("data-live-1").body)).toMatchObject({ schema: 1, createdAt: new Date(T0).toISOString() });
  });

  it("a created_at that reads long ago does not make a release recorded an hour ago old", async () => {
    const server = startedAt();
    server.seed("data-live-1", 1, () => live(0), { madeAt: T0 - HOUR });
    expect((await backendOn(server).releasesOf("live"))[0].createdAt).toBe(new Date(T0 - HOUR).toISOString());
  });

  it("a release with no record, or a record that does not parse, has no creation time", async () => {
    const server = startedAt();
    server.seed("data-live-1", 1, () => live(0), { madeAt: null });
    server.seed("data-live-2", 0, () => "x");
    server.release("data-live-2").body = JSON.stringify({ schema: 2, createdAt: new Date(T0).toISOString() });
    server.seed("data-live-3", 0, () => "x");
    server.release("data-live-3").body = JSON.stringify({ schema: 1, createdAt: "not a date" });
    server.seed("data-live-4", 0, () => "x");
    server.release("data-live-4").published_at = new Date(T0).toISOString(); // published_at alone is not a record
    server.release("data-live-4").body = null;
    expect((await backendOn(server).releasesOf("live")).map((r) => r.createdAt)).toEqual([null, null, null, null]);
  });

  it("published_at is used when it is later than the record, and ignored when it is earlier", async () => {
    const server = startedAt();
    server.seed("data-live-1", 0, () => "x", { madeAt: T0 - 48 * HOUR });
    server.release("data-live-1").published_at = new Date(T0 - HOUR).toISOString();
    server.seed("data-live-2", 0, () => "x", { madeAt: T0 - HOUR });
    server.release("data-live-2").published_at = new Date(T0 - 48 * HOUR).toISOString();
    const both = new Date(T0 - HOUR).toISOString();
    expect((await backendOn(server).releasesOf("live")).map((r) => r.createdAt)).toEqual([both, both]);
  });

  it("the folder backend records the instant in <dir>/.release-records/<tag>.json; a folder with no record has none", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rec-"));
    let t = T0;
    const store = folderBackend(dir, { assetLimit: 2, now: () => t });
    await store.upload(live(0), genBytes(5));
    t = T0 + 5 * HOUR;
    await store.upload(live(1), genBytes(5));
    await store.upload(live(2), genBytes(5)); // rolls over: data-live-2 is made at T0 + 5 h
    expect((await store.releasesOf("live")).map((r) => r.createdAt)).toEqual([new Date(T0).toISOString(), new Date(T0 + 5 * HOUR).toISOString()]);
    expect(JSON.parse(await fs.readFile(path.join(dir, ".release-records", "data-live-1.json"), "utf8"))).toMatchObject({ schema: 1, createdAt: new Date(T0).toISOString() });
    await fs.rm(path.join(dir, ".release-records", "data-live-1.json"));
    expect((await store.releasesOf("live"))[0].createdAt).toBe(null);
    await fs.rm(dir, { recursive: true, force: true });
  });

});

// A process never creates a release number it has seen, never uploads below the newest, and
// learns the newest again every NEWEST_RELEASE_MAX_AGE_MS (round 4, items 2 to 4).
describe("the uploader and releases that disappear", () => {
  const tagOf = (up) => up.loc.slice(0, up.loc.indexOf("/"));

  it("P2: a release that vanished is not created again after a listing, and the pack goes to the newest", async () => {
    const server = startedAt();
    const a = backendOn(server, { assetLimit: 3 });
    await a.upload(live(0), genBytes(5)); // current = 1
    goneTag(server, "data-live-1");
    server.seed("data-live-2", 1, () => live(7));
    await a.list("live");
    expect(tagOf(await a.upload(live(1), genBytes(5)))).toBe("data-live-2");
    expect(server.release("data-live-1")).toBe(null);
  });

  it("P4: the newest release is deleted under the process: the next release is above every number it saw, not an older one", async () => {
    const server = startedAt();
    const a = backendOn(server, { assetLimit: 3 });
    for (let i = 0; i < 4; i++) await a.upload(live(i), genBytes(5, i)); // 1 full, 2 holds one: current = 2
    goneTag(server, "data-live-2");
    expect(tagOf(await a.upload(live(9), genBytes(5)))).toBe("data-live-3"); // release 1 is full here, so also seed room below
    expect(server.release("data-live-2")).toBe(null);
  });

  it("P4 with room below: release 1 has a free slot but is below the highest number seen", async () => {
    const server = startedAt();
    const a = backendOn(server, { assetLimit: 3 });
    for (let i = 0; i < 4; i++) await a.upload(live(i), genBytes(5, i));
    await a.delete(`data-live-1/${live(0)}`);
    goneTag(server, "data-live-2");
    expect(tagOf(await a.upload(live(9), genBytes(5)))).toBe("data-live-3");
  });

  it("no release is created at or below the highest number seen: the one place that creates refuses it", async () => {
    const server = startedAt();
    const a = backendOn(server, { assetLimit: 3 });
    await a.upload(live(0), genBytes(5));
    const before = server.counts.createRelease;
    goneTag(server, "data-live-1");
    await a.upload(live(1), genBytes(5));
    expect(server.counts.createRelease - before).toBe(1); // only data-live-2
    expect(server.release("data-live-1")).toBe(null);
  });

  it("P3: a retry of a name whose release was deleted goes to a new target and is stored there", async () => {
    const server = startedAt();
    const a = backendOn(server, { assetLimit: 3 });
    await a.upload(live(0), genBytes(5, 1));
    goneTag(server, "data-live-1");
    const again = await a.upload(live(0), genBytes(5, 1)); // the same name: posted to the release that is gone
    expect(tagOf(again)).toBe("data-live-2");
    expect(server.release("data-live-2").assets.map((x) => x.name)).toEqual([live(0)]);
  });

  it("a 422 whose release then proves gone re-targets too (the refusal path)", async () => {
    const server = startedAt();
    const a = backendOn(server, { assetLimit: 3 });
    await a.upload(live(0), genBytes(5));
    let first = true;
    const http = async (url, init) => {
      if (first && init?.method === "POST" && String(url).includes("/assets?name=")) {
        first = false;
        goneTag(server, "data-live-1");
        return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
      }
      return server.http(url, init);
    };
    const b = backendOn(server, { assetLimit: 3, http });
    b.refresh("live");
    expect(tagOf(await b.upload(live(1), genBytes(5)))).toBe("data-live-2");
  });

  it("a process that lives 25 hours uploads into the newest release, not into a freed slot below it", async () => {
    const server = startedAt();
    const a = backendOn(server, { assetLimit: 3 });
    await a.upload(live(0), genBytes(5)); // current = 1, learned at T0
    const b = backendOn(server, { assetLimit: 3 });
    for (let i = 1; i < 7; i++) await b.upload(live(i), genBytes(5, i)); // 1 full, 2 full, 3 holds one
    await b.delete(`data-live-1/${live(0)}`); // a slot is free in 1
    server.clock.t += 25 * HOUR;
    const made = server.releases.map((r) => r.tag_name);
    expect(tagOf(await a.upload(live(20), genBytes(5)))).toBe("data-live-3");
    expect(server.releases.map((r) => r.tag_name)).toEqual(made);
  });

  it("cost: no release listing inside the hour, one after it", async () => {
    const server = startedAt();
    const a = backendOn(server);
    await a.upload(live(0), genBytes(5));
    const listed = server.counts.listReleases;
    server.clock.t += HOUR - 1000;
    await a.upload(live(1), genBytes(5));
    expect(server.counts.listReleases).toBe(listed);
    const core = a.stats().core;
    await a.upload(live(2), genBytes(5));
    expect(a.stats().core - core).toBe(3);
    server.clock.t += 2000;
    await a.upload(live(3), genBytes(5));
    expect(server.counts.listReleases).toBe(listed + 3); // two counts and a page
  });
});

// A release number whose release was deleted by hand is not made again, even for a process that never saw it:
// GitHub keeps the git tag, and the one place that creates checks for it (one extra request per creation).
describe("a deleted release number is found by its surviving tag", () => {
  const tagOf = (up) => up.loc.slice(0, up.loc.indexOf("/"));
  // Releases 1 and 2 were made by another process; 2 was deleted by hand, so only its tag is left.
  async function oneLeft() {
    const server = startedAt();
    const maker = backendOn(server, { assetLimit: 1 });
    await maker.upload(live(0), genBytes(5));
    await maker.upload(live(1), genBytes(5)); // limit 1: this creates data-live-2
    goneTag(server, "data-live-2");
    return server;
  }

  it("a stale seqs hint that names the deleted number goes to the next number", async () => {
    const server = await oneLeft();
    const fresh = backendOn(server, { assetLimit: 1, seqs: { live: 2 } });
    expect(tagOf(await fresh.upload(live(2), genBytes(5)))).toBe("data-live-3");
    expect(server.release("data-live-2")).toBe(null);
  });

  it("without a hint the same fresh process also never re-creates it", async () => {
    const server = await oneLeft();
    expect(tagOf(await backendOn(server, { assetLimit: 3 }).upload(live(2), genBytes(5)))).toBe("data-live-1");
    expect(server.release("data-live-2")).toBe(null);
  });

  it("skips several used numbers up to the bound, then throws a named error", async () => {
    const server = startedAt();
    for (let q = 2; q <= 4; q++) server.tags.add(`data-live-${q}`);
    expect(tagOf(await backendOn(server, { seqs: { live: 2 } }).upload(live(0), genBytes(5)))).toBe("data-live-5");
    const jammed = startedAt();
    for (let q = 2; q <= 30; q++) jammed.tags.add(`data-live-${q}`);
    await expect(backendOn(jammed, { seqs: { live: 2 } }).upload(live(0), genBytes(5))).rejects.toThrow(/release numbers .* used/);
    expect(jammed.releases).toEqual([]);
  });

  it("cost: one extra request per creation, none when the release exists", async () => {
    const server = startedAt();
    const store = backendOn(server);
    await store.upload(live(0), genBytes(5)); // listing 3 + get 1 + tag check 1 + create 1 + count 1 + upload 2
    expect(server.counts.getTagRef).toBe(1);
    expect(server.counts.createRelease).toBe(1);
    expect(store.stats().core).toBe(9);
    const core = store.stats().core;
    await store.upload(live(1), genBytes(5));
    expect(store.stats().core - core).toBe(3); // no creation, no tag check
    expect(server.counts.getTagRef).toBe(1);
  });

  it("the folder backend: a record with no folder means the number was used", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "used-"));
    const store = folderBackend(dir, { assetLimit: 1, now: () => T0 });
    await store.upload(live(0), genBytes(5));
    await store.upload(live(1), genBytes(5)); // data-live-2
    await fs.rm(path.join(dir, "data-live-2"), { recursive: true }); // the newest folder deleted by hand; its record stays
    expect(tagOf(await store.upload(live(2), genBytes(5)))).toBe("data-live-3");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("deleting a folder release keeps its record, as GitHub keeps the tag; an orphan record only skips a number", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "used-"));
    const store = folderBackend(dir, { assetLimit: 2, now: () => T0 });
    const { loc } = await store.upload(live(0), genBytes(5));
    await store.delete(loc);
    await store.deleteRelease("data-live-1");
    await fs.stat(path.join(dir, ".release-records", "data-live-1.json"));
    expect(tagOf(await store.upload(live(1), genBytes(5)))).toBe("data-live-2");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
