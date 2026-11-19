// The sweep's release delete over the release backend and the fake server (round 4): the age of
// the successor comes from the creator's record and not from created_at, and the two switches
// that make a first real run safe, `dryRun` (the default) and `deleteReleases`.
import { describe, it, expect } from "vitest";
import { runSweep } from "./sweep.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { NOW, livePack, packBytes, putObject, backendOn, exists, sweepArgs } from "./sweepKit.js";

const HOUR = 3_600_000;
const nowMs = Date.parse(NOW);
const CURRENT = { live: "data-live-2", hist: "data-hist-1", events: "data-events-1", site: "data-site-1" };

// data-live-1 is empty; data-live-2 holds one young pack and was made at `madeAt` (null: no record).
function twoReleases(madeAt) {
  const server = createFakeReleaseServer();
  server.seed("data-live-1", 0, () => "unused");
  server.seed("data-live-2", 0, () => "unused", { madeAt });
  return server;
}
const withYoung = async (server) => putObject(server, "data-live-2", livePack(2), await packBytes(), { ageDays: 1 });
const sweep = (server, over = {}) => runSweep(sweepArgs(backendOn(server), { currentReleases: CURRENT, ...over }));
const keptCode = (run, tag) => run.plan.summary.releasesKept.find((r) => r.tag === tag)?.code;

describe("the successor's age is the recorded instant, not created_at", () => {
  it("a successor whose created_at reads long ago but was recorded an hour ago keeps the release", async () => {
    const server = twoReleases(nowMs - HOUR);
    await withYoung(server);
    expect(server.release("data-live-2").created_at).toBe("2019-06-01T00:00:00.000Z");
    const run = await sweep(server);
    expect(run.plan.releasesToDelete).toEqual([]);
    expect(keptCode(run, "data-live-1")).toBe("successor-too-young");
    expect(server.release("data-live-1")).not.toBe(null);
  });

  it("a successor recorded 25 hours ago lets the release go", async () => {
    const server = twoReleases(nowMs - 25 * HOUR);
    await withYoung(server);
    const run = await sweep(server);
    expect(run.executed.releasesDeleted).toEqual(["data-live-1"]);
    expect(server.release("data-live-1")).toBe(null);
  });

  it("a successor with no record keeps the release and reports it, whatever created_at says", async () => {
    const server = twoReleases(null);
    await withYoung(server);
    const run = await sweep(server);
    expect(run.executed.releasesDeleted).toEqual([]);
    expect(keptCode(run, "data-live-1")).toBe("successor-created-unknown");
    expect(run.summary.reported.map((r) => r.code)).toContain("successor-created-unknown");
    expect(exists(server, `data-live-2/${livePack(2)}`)).toBe(true);
  });

  it("published_at later than the record keeps it: the release is as young as the latest evidence", async () => {
    const server = twoReleases(nowMs - 48 * HOUR);
    server.release("data-live-2").published_at = new Date(nowMs - HOUR).toISOString();
    await withYoung(server);
    expect(keptCode(await sweep(server), "data-live-1")).toBe("successor-too-young");
  });
});

describe("the switches of a first real run", () => {
  it("dryRun is the default: nothing is deleted unless the caller passes dryRun: false", async () => {
    const server = twoReleases(nowMs - 25 * HOUR);
    const old = putObject(server, "data-live-1", livePack(1), await packBytes(), { ageDays: 30 });
    const run = await sweep(server, { coins: ["example"], dryRun: undefined });
    expect(run.plan.delete.map((d) => d.loc)).toEqual([old]);
    expect(run.executed).toBe(null);
    expect(exists(server, old)).toBe(true);
    expect(server.counts.deleteAsset ?? 0).toBe(0);
    const real = await sweep(server, { coins: ["example"], dryRun: false });
    expect(real.executed.deleted).toEqual([old]);
  });

  it("a dry run with no sleep or packsWritten needs neither", async () => {
    const run = await runSweep({ ...sweepArgs(backendOn(twoReleases(null))), currentReleases: CURRENT, dryRun: undefined, sleep: undefined, packsWritten: undefined });
    expect(run.executed).toBe(null);
  });

  it("deleteReleases: false deletes the objects and leaves the empty release in place, reported", async () => {
    const server = twoReleases(nowMs - 25 * HOUR);
    await withYoung(server);
    const old = putObject(server, "data-live-1", livePack(1), await packBytes(), { ageDays: 30 });
    const run = await sweep(server, { coins: ["example"], deleteReleases: false });
    expect(run.executed.deleted).toEqual([old]);
    expect(run.executed.releasesDeleted).toEqual([]);
    expect(server.release("data-live-1")).not.toBe(null);
    expect(server.counts.deleteRelease ?? 0).toBe(0);
    expect(run.summary.releasesLeftInPlace).toEqual(["data-live-1"]);
    expect(run.summary.reported).toContainEqual(expect.objectContaining({ loc: "data-live-1", code: "release-deletes-off" }));
  });

  it("deleteReleases defaults to on", async () => {
    const server = twoReleases(nowMs - 25 * HOUR);
    await withYoung(server);
    const run = await sweep(server);
    expect(run.executed.releasesDeleted).toEqual(["data-live-1"]);
    expect(run.summary.releasesLeftInPlace).toEqual([]);
  });
});

describe("the sweep's clock", () => {
  it("rejects now and today with a named error that says to pass clock", async () => {
    const args = sweepArgs(backendOn(twoReleases(null)));
    await expect(runSweep({ ...args, now: NOW })).rejects.toThrow(/SweepClockArgError|pass `clock`/);
    await expect(runSweep({ ...args, today: "2026-11-19" })).rejects.toMatchObject({ name: "SweepClockArgError" });
  });

  it("reads the clock once and derives today from it", async () => {
    const calls = [];
    const run = await runSweep({ ...sweepArgs(backendOn(twoReleases(null))), currentReleases: CURRENT, dryRun: true, clock: () => (calls.push(1), Date.UTC(2026, 10, 19, 23, 59, 59)) });
    expect(calls.length).toBe(1);
    expect(run.plan).toBeDefined();
  });

  it("defaults to the system clock", async () => {
    const args = sweepArgs(backendOn(twoReleases(null)));
    delete args.clock;
    await expect(runSweep({ ...args, currentReleases: CURRENT, dryRun: true })).resolves.toBeDefined();
  });
});
