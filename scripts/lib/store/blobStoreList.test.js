// The blob store calls other slices needed: listRelease(tag), the creation time and state in
// stat(loc), and the release tags of a series with their request count. Both backends, with
// the request cost of each call pinned (BUDGET in blobStore.js states the worst case).
import { afterAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { BUDGET, StoreHttpError, StoreNameError } from "./blobStore.js";
import { folderBackend } from "./blobStoreFolder.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { packName } from "./packNames.js";

const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const live = (n) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 3, attempt: 1, lane: 0, flush: n });
const hist = (n) => packName({ cls: "hist", kind: "holders", day: "2026-11-18", run: 3, attempt: 1, lane: 0, flush: n });

describe("listRelease on a server that fails", () => {
  const failFour = (server) => { for (let i = 0; i < 4; i++) server.failAt(i, 500, "api"); };

  it("a 5xx on the release lookup is an error, never 'no assets'", async () => {
    const server = createFakeReleaseServer();
    const make = () => releaseBackend({ owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t, sleep: async (ms) => { server.clock.t += ms; }, assetLimit: 900 });
    await make().upload(live(0), Buffer.from("aaaa"));
    const cold = make();
    failFour(server);
    await expect(cold.listRelease("data-live-1")).rejects.toBeInstanceOf(StoreHttpError);
    expect((await cold.listRelease("data-live-1")).entries).toHaveLength(1); // the release is there once the server answers
  });

  it("a 5xx while the assets are listed is an error too", async () => {
    const server = createFakeReleaseServer();
    const store = releaseBackend({ owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t, sleep: async (ms) => { server.clock.t += ms; }, assetLimit: 900 });
    await store.upload(live(0), Buffer.from("aaaa"));
    failFour(server);
    await expect(store.listRelease("data-live-1")).rejects.toBeInstanceOf(StoreHttpError);
  });
});

const BACKENDS = {
  folder: () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blist-"));
    dirs.push(dir);
    const make = () => folderBackend(dir, { assetLimit: 900 });
    return { store: make(), fresh: make, requests: () => 0 };
  },
  release: () => {
    const server = createFakeReleaseServer();
    const make = () => releaseBackend({ owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t, sleep: async (ms) => { server.clock.t += ms; }, assetLimit: 900 });
    return { store: make(), fresh: make, server, requests: (b) => b.stats().core };
  },
};

describe.each(Object.entries(BACKENDS))("blob store lists on the %s backend", (label, make) => {
  const isRelease = label === "release";

  it("listRelease(tag): the assets of one release with name, size, release, state, loc and createdAt, and its request count", async () => {
    const env = make();
    const a = await env.store.upload(live(0), Buffer.from("aaaa"));
    const b = await env.store.upload(live(1), Buffer.from("bbbbbb"));
    await env.store.upload(hist(0), Buffer.from("elsewhere"));
    const before = env.requests(env.store);
    const got = await env.store.listRelease("data-live-1");
    expect(got.entries.map((e) => [e.name, e.size, e.release, e.state, e.loc])).toEqual([
      [live(0), 4, "data-live-1", "uploaded", a.loc],
      [live(1), 6, "data-live-1", "uploaded", b.loc],
    ]);
    expect(got.entries.every((e) => typeof e.createdAt === "string" && !Number.isNaN(Date.parse(e.createdAt)))).toBe(true);
    expect(Object.keys(got).sort()).toEqual(["entries", "requests"]);
    expect(got.requests).toBe(isRelease ? 3 : 0); // a count, one page, a count; the release was cached by the uploads
    expect(env.requests(env.store) - before).toBe(got.requests);
    expect(got.requests).toBeLessThanOrEqual(isRelease ? BUDGET.listRelease : 0);
  });

  it("listRelease on a cold process also looks the release up: one more request", async () => {
    const env = make();
    await env.store.upload(live(0), Buffer.from("aaaa"));
    const cold = env.fresh();
    const got = await cold.listRelease("data-live-1");
    expect(got.entries).toHaveLength(1);
    expect(got.requests).toBe(isRelease ? 4 : 0);
    expect(got.requests).toBeLessThanOrEqual(isRelease ? BUDGET.listReleaseByTag : 0);
  });

  it("listRelease of a release that does not exist answers empty entries, not an error", async () => {
    const env = make();
    await env.store.upload(live(0), Buffer.from("aaaa"));
    const got = await env.fresh().listRelease("data-live-9");
    expect(got.entries).toEqual([]);
    expect(got.requests).toBe(isRelease ? 1 : 0);
    await expect(env.store.listRelease("not-a-tag")).rejects.toBeInstanceOf(StoreNameError);
  });

  it("listRelease of a full-size release costs pages + 2 requests (250 assets: 3 pages)", async () => {
    if (!isRelease) return;
    const env = make();
    env.server.seed("data-live-1", 250, (i) => live(i));
    const got = await env.fresh().listRelease("data-live-1");
    expect(got.entries).toHaveLength(250);
    expect(got.requests).toBe(1 + 3 + 2);
  });

  it("stat(loc) also gives createdAt and state where the backend knows them, with no request", async () => {
    const env = make();
    const up = await env.store.upload(live(0), Buffer.from("aaaa"));
    const before = env.requests(env.store);
    const known = await env.store.stat(up.loc);
    expect(known).toMatchObject({ size: 4, loc: up.loc, state: "uploaded" });
    expect(typeof known.createdAt).toBe("string");
    expect(env.requests(env.store) - before).toBe(0);
    const cold = env.fresh();
    const bare = await cold.stat(up.loc);
    expect(bare).toMatchObject({ size: 4, loc: up.loc });
    if (isRelease) {
      expect("createdAt" in bare).toBe(false); // a signed read tells the size and nothing else
      await cold.listRelease("data-live-1");
      expect(await cold.stat(up.loc)).toMatchObject({ state: "uploaded", createdAt: known.createdAt });
    } else {
      expect(bare.state).toBe("uploaded");
    }
    expect(await cold.stat("data-live-1/" + live(5))).toBe(null);
  });

  it("listReleaseTags(series): the release tags that exist, empty ones included, and the requests it took", async () => {
    const env = make();
    await env.store.upload(live(0), Buffer.from("aaaa"));
    await env.store.upload(hist(0), Buffer.from("h"));
    if (isRelease) env.server.seed("data-live-2", 0, () => "unused");
    else fs.mkdirSync(path.join(dirs.at(-1), "data-live-2"));
    const cold = env.fresh();
    const got = await cold.listReleaseTags("live");
    expect(got.releases.map((r) => [r.tag, r.seq])).toEqual([["data-live-1", 1], ["data-live-2", 2]]);
    expect(got.releases.every((r) => r.createdAt === null || typeof r.createdAt === "string")).toBe(true);
    expect(got.requests).toBe(isRelease ? 3 : 0); // the repository's release list: count, one page, count; no asset listing
    expect(got.requests).toBeLessThanOrEqual(isRelease ? BUDGET.listReleaseTags(3) : 0);
    expect(Object.keys(got).sort()).toEqual(["releases", "requests"]);
    await expect(cold.listReleaseTags("nope")).rejects.toBeInstanceOf(StoreNameError);
  });
});
