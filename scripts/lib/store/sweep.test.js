// The sweep's I/O on the release backend over the fake server: what it deletes and keeps,
// the stop rules (a throwing references call, a failing plan, a 403 or 429), pacing and
// the cap with a recording clock, and the cost of a run by size.
import { describe, it, expect } from "vitest";
import { runSweep } from "./sweep.js";
import { SweepPlanError, SweepDeleteError } from "./sweepErrors.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { openPack } from "./pack.js";
import { SWEEP_DELETE_GAP_MS } from "./storeConstants.js";
import { dayBefore } from "./sweepRules.js";
import { TODAY, ok, livePack, histPack, eventsPack, packBytes, putObject, backendOn, exists, sweepArgs } from "./sweepKit.js";

const T = 20000;
const CURRENT2 = { live: "data-live-2", hist: "data-hist-1", events: "data-events-1", site: "data-site-1" };

describe("a night of the sweep", () => {
  it("deletes what the rules allow, keeps the rest, reads the referenced pack, and removes the emptied release", async () => {
    const server = createFakeReleaseServer();
    const bytes = await packBytes();
    const old = putObject(server, "data-live-1", livePack(1), bytes, { ageDays: 30 });
    const named = putObject(server, "data-live-1", livePack(2), bytes, { ageDays: 30 });
    const young = putObject(server, "data-live-1", livePack(3), bytes, { ageDays: 3 });
    const stale = putObject(server, "data-live-2", livePack(4), bytes, { ageDays: 40 });
    const newest = putObject(server, "data-live-3", livePack(11), bytes, { ageDays: 1 }); // the newest release of the series: data-live-2 may go
    const events = putObject(server, "data-events-1", eventsPack(5, dayBefore(TODAY, 9)), await packBytes({ cls: "events" }), { ageDays: 9 });
    const junk = putObject(server, "data-live-1", "notes.txt", Buffer.from("hand kept"), { ageDays: 90 });
    const blobs = backendOn(server);
    const run = await runSweep(sweepArgs(blobs, { refs: { example: ok("example", [named]) }, currentReleases: { live: "data-live-3", hist: "data-hist-1", events: "data-events-1", site: "data-site-1" } }));
    expect(run.executed.deleted.sort()).toEqual([old, stale, events].sort());
    for (const loc of [named, young, junk, newest]) expect(exists(server, loc), loc).toBe(true);
    expect(run.executed.releasesDeleted).toEqual(["data-live-2"]);
    expect(server.release("data-live-2")).toBe(null);
    const pack = await openPack({ name: named, size: bytes.length, readRange: (o, l) => blobs.readRange(named, o, l) });
    expect(pack.header.slugs).toEqual(["example"]);
    expect(run.summary.byClass.live).toMatchObject({ listed: 6, planned: 2, deleted: 2, bytesDeleted: 2 * bytes.length, bytesWaiting: 2 * bytes.length });
    expect(run.summary.byClass.live.kept).toEqual({ referenced: 1, "too-young": 2, "not-a-store-name": 1 });
    expect(run.summary.reported.map((r) => r.loc)).toEqual([junk]);
  }, T);

  it("a dry run returns the plan and deletes nothing, with no pacing", async () => {
    const server = createFakeReleaseServer();
    const old = putObject(server, "data-live-1", livePack(1), await packBytes(), { ageDays: 30 });
    const slept = [];
    const run = await runSweep(sweepArgs(backendOn(server), { coins: ["example"], dryRun: true, sleep: async (ms) => slept.push(ms) }));
    expect(run.plan.delete.map((d) => d.loc)).toEqual([old]);
    expect(run.executed).toBe(null);
    expect(exists(server, old)).toBe(true);
    expect(server.counts.deleteAsset ?? 0).toBe(0);
    expect(slept).toEqual([]);
  }, T);

  it("a dead upload goes after one day without its header being read", async () => {
    const server = createFakeReleaseServer();
    const dead = putObject(server, "data-live-1", livePack(1), Buffer.from("HDB1 half"), { ageDays: 1, state: "starter" });
    const fresh = putObject(server, "data-live-1", livePack(2), Buffer.from("HDB1 half"), { ageDays: 0, state: "starter" });
    const run = await runSweep(sweepArgs(backendOn(server)));
    expect(run.executed.deleted).toEqual([dead]);
    expect(exists(server, fresh)).toBe(true);
    expect(run.summary.headerReads.reads).toBe(0);
  }, T);

  it("a pack whose header cannot be read is kept and reported with the reason", async () => {
    const server = createFakeReleaseServer();
    const bad = putObject(server, "data-live-1", livePack(1), Buffer.from("not a pack at all, no magic here"), { ageDays: 30 });
    const noCoins = putObject(server, "data-live-1", livePack(2), await packBytes({ slugs: null }), { ageDays: 30 });
    const run = await runSweep(sweepArgs(backendOn(server)));
    expect(run.executed.deleted).toEqual([]);
    expect(run.summary.byClass.live.kept).toEqual({ "header-unreadable": 1, "no-coin-list": 1 });
    // told apart in the run summary, with their bytes
    expect(run.summary.keptHeaderUnreadable).toEqual({ packs: 1, bytes: Buffer.from("not a pack at all, no magic here").length });
    expect(run.summary.keptNoCoinList.packs).toBe(1);
    expect(run.summary.keptNoCoinList.bytes).toBeGreaterThan(0);
    expect(run.headerErrors.map((e) => e.loc).sort()).toEqual([bad, noCoins].sort());
    expect(run.headerErrors.find((e) => e.loc === noCoins)).toMatchObject({ failure: "no-coin-list", error: expect.stringMatching(/no list of coins/) });
    expect(run.headerErrors.find((e) => e.loc === bad).error).toMatch(/wrong magic/);
  }, T);

  it("an injected coinsOfPack replaces the header read", async () => {
    const server = createFakeReleaseServer();
    const old = putObject(server, "data-live-1", livePack(1), Buffer.from("opaque"), { ageDays: 30 });
    const run = await runSweep(sweepArgs(backendOn(server), { coins: ["example"], coinsOfPack: async () => ({ coins: ["example"] }) }));
    expect(run.executed.deleted).toEqual([old]);
  }, T);
});

describe("when nothing may be deleted", () => {
  async function seeded() {
    const server = createFakeReleaseServer();
    const bytes = await packBytes();
    const locs = [1, 2, 3].map((n) => putObject(server, "data-live-1", livePack(n), bytes, { ageDays: 30 }));
    return { server, locs };
  }

  it("a referencesFor that throws for one coin rethrows its error, with no delete and no listing", async () => {
    const { server, locs } = await seeded();
    const boom = new Error("manifest of b exploded");
    const args = sweepArgs(backendOn(server), { coins: ["a", "b", "c"], referencesFor: async (s) => { if (s === "b") throw boom; return ok(s, []); } });
    await expect(runSweep(args)).rejects.toBe(boom);
    expect(server.counts.deleteAsset ?? 0).toBe(0);
    expect(server.counts.listReleases ?? 0).toBe(0);
    for (const loc of locs) expect(exists(server, loc)).toBe(true);
  }, T);

  it("a plan that cannot be built rethrows and deletes nothing", async () => {
    const { server, locs } = await seeded();
    const args = sweepArgs(backendOn(server), { coins: ["example"], historyDays: 100 });
    await expect(runSweep(args)).rejects.toBeInstanceOf(SweepPlanError);
    await expect(runSweep(sweepArgs(backendOn(server), { coins: ["example"], currentReleases: { live: "data-live-1" } }))).rejects.toThrow(/no current release given for the hist series/);
    expect(server.counts.deleteAsset ?? 0).toBe(0);
    for (const loc of locs) expect(exists(server, loc)).toBe(true);
  }, T);

  it("removedCoins and oldestNeededDay have no default: leaving one out is a named error, before anything is read", async () => {
    const { server } = await seeded();
    for (const key of ["removedCoins", "oldestNeededDay"]) {
      const args = sweepArgs(backendOn(server), { coins: ["example"] });
      delete args[key];
      await expect(runSweep(args), key).rejects.toThrow(new RegExp(key + " must be given as a Map"));
    }
    expect(server.counts.listReleases ?? 0).toBe(0);
  }, T);

  it("bad arguments are refused before anything is read", async () => {
    const { server } = await seeded();
    await expect(runSweep(sweepArgs(backendOn(server), { coins: ["a", "a"] }))).rejects.toThrow(/distinct slugs/);
    await expect(runSweep(sweepArgs(backendOn(server), { packsWritten: -1 }))).rejects.toThrow(/packsWritten/);
    await expect(runSweep(sweepArgs(backendOn(server), { sleep: null }))).rejects.toThrow(/sleep/);
    expect(server.counts.listReleases ?? 0).toBe(0);
  }, T);
});

// Records every call the sweep makes into the store and every sleep, in order.
function recording(blobs, log) {
  return new Proxy(blobs, {
    get: (t, k) => (k === "delete" || k === "deleteRelease" ? async (x) => { log.push(`${String(k)} ${x}`); return t[k](x); } : t[k]),
  });
}

describe("pacing and the cap", () => {
  async function five() {
    const server = createFakeReleaseServer();
    const bytes = await packBytes();
    const locs = [1, 2, 3, 4, 5].map((n) => putObject(server, "data-live-1", livePack(n), bytes, { ageDays: 30 }));
    putObject(server, "data-live-2", livePack(9), bytes, { ageDays: 0 });
    return { server, locs };
  }

  it("deletes one at a time, one second apart on the injected clock", async () => {
    const { server, locs } = await five();
    const log = [];
    const sleep = async (ms) => log.push(`sleep ${ms}`);
    const run = await runSweep(sweepArgs(recording(backendOn(server), log), { coins: ["example"], sleep, packsWritten: 50, currentReleases: CURRENT2 }));
    const gap = `sleep ${SWEEP_DELETE_GAP_MS}`;
    expect(run.executed.deleted).toEqual([...locs].sort());
    // five deletes and then the emptied release: five gaps, never before the first or after the last
    expect(log).toEqual([...locs].sort().flatMap((l, i) => (i ? [gap, `delete ${l}`] : [`delete ${l}`])).concat([gap, "deleteRelease data-live-1"]));
    expect(SWEEP_DELETE_GAP_MS).toBe(1000);
  }, T);

  it("is capped at twice the packs written in this run and reports what it left", async () => {
    const { server, locs } = await five();
    const log = [];
    const run = await runSweep(sweepArgs(recording(backendOn(server), log), { coins: ["example"], sleep: async (ms) => log.push(`sleep ${ms}`), packsWritten: 1, currentReleases: CURRENT2 }));
    expect(run.executed.deleted).toHaveLength(2);
    expect(run.executed.leftByCap).toBe(4); // three more objects and the release
    expect(run.executed.left).toBe(4);
    expect(log.filter((e) => e.startsWith("sleep"))).toHaveLength(1);
    const left = locs.filter((l) => !run.executed.deleted.includes(l));
    expect(left).toHaveLength(3);
    for (const l of left) expect(exists(server, l)).toBe(true);
    // the next night continues from where this one stopped
    const next = await runSweep(sweepArgs(backendOn(server), { coins: ["example"], packsWritten: 1, currentReleases: CURRENT2 }));
    expect(next.executed.deleted).toHaveLength(2);
    expect((await runSweep(sweepArgs(backendOn(server), { coins: ["example"], packsWritten: 0, currentReleases: CURRENT2 }))).executed.deleted).toEqual([]);
  }, T);

  it("a cap of zero deletes nothing", async () => {
    const { server, locs } = await five();
    const run = await runSweep(sweepArgs(backendOn(server), { coins: ["example"], packsWritten: 0, currentReleases: CURRENT2 }));
    expect(run.executed).toMatchObject({ deleted: [], leftByCap: 6, left: 6 });
    for (const l of locs) expect(exists(server, l)).toBe(true);
  }, T);
});

// A transport that answers the n-th DELETE of an asset with `reply` and counts them.
function failingDelete(server, nth, reply) {
  const state = { deletes: 0 };
  const http = (url, init = {}) => {
    if ((init.method ?? "GET") === "DELETE" && /\/releases\/assets\//.test(String(url))) {
      if (++state.deletes === nth) return Promise.resolve(reply());
    }
    return server.http(url, init);
  };
  return { http, state };
}

describe("stop at the first 403 or 429", () => {
  const cases = [
    ["a plain 403", () => new Response("{}", { status: 403 }), {}],
    ["a 429 with retry-after", () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }), { maxRateWaitMs: 0 }],
  ];
  for (const [label, reply, opts] of cases) {
    it(`${label} on the third delete: two done, the rest reported, no retry`, async () => {
      const server = createFakeReleaseServer();
      const bytes = await packBytes();
      const locs = [1, 2, 3, 4, 5].map((n) => putObject(server, "data-live-1", livePack(n), bytes, { ageDays: 30 }));
      putObject(server, "data-live-2", livePack(9), bytes, { ageDays: 0 }); // the newest release, so data-live-1 may go
      const { http, state } = failingDelete(server, 3, reply);
      const run = await runSweep(sweepArgs(backendOn(server, { http, ...opts }), { coins: ["example"], currentReleases: CURRENT2 }));
      const sorted = [...locs].sort();
      expect(run.executed.deleted).toEqual(sorted.slice(0, 2));
      expect(run.executed.stopped.at).toBe(sorted[2]);
      expect(run.executed.stopped.error).toMatch(/403|429/);
      expect(run.executed.left).toBe(3 + 1); // three objects and the release it would have emptied
      expect(state.deletes).toBe(3); // nothing sent after the refusal, and the refused one was not sent again
      expect(server.counts.deleteAsset).toBe(2);
      for (const l of sorted.slice(2)) expect(exists(server, l)).toBe(true);
      expect(server.counts.deleteRelease ?? 0).toBe(0);
    }, T);
  }

  it("any other failure of a delete rethrows with the location and rule, and the work done so far", async () => {
    const server = createFakeReleaseServer();
    const bytes = await packBytes();
    [1, 2, 3].forEach((n) => putObject(server, "data-live-1", livePack(n), bytes, { ageDays: 30 }));
    const { http } = failingDelete(server, 2, () => new Response("{}", { status: 400 }));
    const err = await runSweep(sweepArgs(backendOn(server, { http }), { coins: ["example"] })).catch((e) => e);
    expect(err).toBeInstanceOf(SweepDeleteError);
    expect(err.message).toMatch(/delete of data-live-1\/p\.live\.holders\.2026-11-01\.r2a1\.l0f0\.hdb failed \(rule: named by no readable coin; 720\.00 h old/);
    expect(err.result.deleted).toHaveLength(1);
  }, T);

  it("a delete of an object another process already removed is counted, not an error", async () => {
    const server = createFakeReleaseServer();
    const bytes = await packBytes();
    const a = putObject(server, "data-live-1", livePack(1), bytes, { ageDays: 30 });
    putObject(server, "data-live-1", livePack(2), bytes, { ageDays: 30 });
    const blobs = backendOn(server);
    const real = blobs.delete;
    blobs.delete = async (loc) => {
      if (loc === a) await real(loc); // removed by someone else just before ours
      return real(loc);
    };
    const run = await runSweep(sweepArgs(blobs, { coins: ["example"] }));
    expect(run.executed.alreadyGone).toEqual([a]);
    expect(run.executed.deleted).toHaveLength(1);
  }, T);
});

describe("cost by size", () => {
  it("one listing per series, and header reads only for deletion candidates, never a whole pack", async () => {
    const server = createFakeReleaseServer();
    const small = await packBytes();
    const big = await packBytes({ pad: 300_000 }); // far larger than one header read
    const candidates = [1, 2, 3].map((n) => putObject(server, "data-live-1", livePack(n), n === 1 ? big : small, { ageDays: 30 }));
    const kept = [4, 5, 6, 7].map((n) => putObject(server, "data-live-1", livePack(n), small, { ageDays: 2 }));
    putObject(server, "data-live-2", livePack(8), small, { ageDays: 2 });
    putObject(server, "data-hist-1", histPack(9, TODAY), small, { ageDays: 2 });
    putObject(server, "data-events-1", eventsPack(10, TODAY), small, { ageDays: 0 });
    const blobs = backendOn(server);
    const run = await runSweep(sweepArgs(blobs, { coins: ["example"], currentReleases: { live: "data-live-2", hist: "data-hist-1", events: "data-events-1", site: "data-site-1" } }));
    expect(run.executed.deleted.sort()).toEqual(candidates.sort());
    // 5 releases with assets plus data-site-1 absent: each series is listed once.
    // A release list costs 3 requests (count, one page, count) per series, and each release's assets 3.
    expect(server.counts.listReleases).toBe(4 * 3);
    expect(server.counts.listAssets).toBe(4 /* releases with assets */ * 3);
    const { headerReads } = run.summary;
    expect(headerReads.packs).toBe(3); // the 3 candidates; the 7 kept packs were not opened
    expect(headerReads.reads).toBe(3); // one range read each: every header fits the first read
    expect(headerReads.bytes).toBeLessThan(3 * (8 + 64 * 1024) + 1);
    expect(headerReads.bytes).toBeLessThan(big.length); // the 300 KB pack was not read whole
    // 12 release-list + 12 asset-list + 3 deletes = 27 core requests; 3 header reads resolve (download) and range-read (signedRead) at no core cost.
    expect(run.summary.requests).toEqual({ core: 27, byKind: { api: 27, download: 3, signedRead: 6 } });
    expect(run.summary.requests.byKind.api).toBe(server.counts.listReleases + server.counts.listAssets + server.counts.deleteAsset + (server.counts.deleteRelease ?? 0) + (server.counts.getRelease ?? 0));
    for (const l of kept) expect(exists(server, l)).toBe(true);
  }, T);
});
