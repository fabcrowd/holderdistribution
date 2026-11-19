// Release backend only: the fields of a created release, request costs, roll-over against
// the fake's hard limit of 1,000 assets, reads by location that never list, the digest
// and read-back identity checks, and every fault switch at every request index.
import { describe, it, expect } from "vitest";
import { memorySink, StoreError, StoreNameTakenError, BUDGET } from "./blobStore.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { createFakeReleaseServer, FAULT_TYPES } from "./fakeReleaseServer.js";
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
    expect(server.release("data-live-1")).toMatchObject({ prerelease: true, make_latest: "false", body: "Generated data, written by the pipeline; do not edit or delete by hand" });
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
