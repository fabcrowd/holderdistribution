// The margin argument as evidence (blobStoreRelease.js header): an upload by another process
// that fires between the sweep's fresh count of a release and its delete request. A process P
// learns release N as the newest, another process makes N+1 (recorded instant), the clock moves,
// and a real sweep (dryRun: false) runs with an http wrapper that starts P's upload() just before
// the release DELETE is sent.
import { describe, it, expect } from "vitest";
import { runSweep } from "./sweep.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { NOW, livePack, putObject, backendOn, exists, sweepArgs } from "./sweepKit.js";

const HOUR = 3_600_000;
const nowMs = Date.parse(NOW);
const CURRENT = { live: "data-live-2", hist: "data-hist-1", events: "data-events-1", site: "data-site-1" };
const PAYLOAD = Buffer.from("the pack P uploads while the sweep runs");

// P learns N = data-live-1 at `learnedAt`; the other process makes data-live-2 at `madeAt` (after that);
// the server clock then moves to `clockAt`. data-live-1 ends up empty, as after a night of deletes.
async function schedule({ learnedAt, madeAt, clockAt }) {
  const server = createFakeReleaseServer({ clock: { t: learnedAt } });
  const p = backendOn(server);
  const first = await p.upload(livePack(1), Buffer.from("first pack of P"));
  await p.delete(first.loc); // P keeps data-live-1 cached as the newest
  server.seed("data-live-2", 0, () => "unused", { madeAt });
  putObject(server, "data-live-2", livePack(2), Buffer.from("young pack of the other process"), { ageDays: 1 });
  server.clock.t = clockAt;
  return { server, p };
}

// Runs the sweep for real; `fire` decides which request P's upload() starts before.
async function sweepWith(server, p, fire, over = {}) {
  const log = { fired: false, upload: null };
  const http = async (url, init) => {
    if (!log.fired && fire(String(url), init)) {
      log.fired = true;
      log.upload = await p.upload(livePack(50), PAYLOAD);
    }
    return server.http(url, init);
  };
  const run = await runSweep(sweepArgs(backendOn(server, { http }), { currentReleases: CURRENT, dryRun: false, ...over }));
  return { run, log };
}
const beforeReleaseDelete = (url, init) => init?.method === "DELETE" && /\/releases\/\d+$/.test(url);
const readable = async (server, loc) => (await backendOn(server).readRange(loc, 0, PAYLOAD.length)).equals(PAYLOAD);

describe("an upload between the sweep's count and its release delete", () => {
  it("successor 24 h and 1 s old: P re-learns, stores in the successor, readable afterwards; the old release goes empty", async () => {
    const { server, p } = await schedule({ learnedAt: nowMs - 24 * HOUR - 2000, madeAt: nowMs - 24 * HOUR - 1000, clockAt: nowMs });
    const { run, log } = await sweepWith(server, p, beforeReleaseDelete);
    expect(log.fired).toBe(true);
    expect(log.upload.loc).toBe(`data-live-2/${livePack(50)}`);
    expect(exists(server, log.upload.loc)).toBe(true);
    expect(await readable(server, log.upload.loc)).toBe(true);
    expect(run.executed.releasesDeleted).toEqual(["data-live-1"]);
    expect(server.release("data-live-1")).toBe(null);
  });

  it("successor 23 h old: the old release is kept as successor-too-young, and P's upload is stored and readable", async () => {
    const { server, p } = await schedule({ learnedAt: nowMs - 23 * HOUR - 1000, madeAt: nowMs - 23 * HOUR, clockAt: nowMs });
    // No release delete is sent, so P starts at the sweep's first listing of the successor's assets.
    const { run, log } = await sweepWith(server, p, (url) => /\/releases\/\d+\/assets\?per_page=100/.test(url));
    expect(run.plan.summary.releasesKept.find((r) => r.tag === "data-live-1").code).toBe("successor-too-young");
    expect(run.executed.releasesDeleted).toEqual([]);
    expect(server.release("data-live-1")).not.toBe(null);
    expect(log.upload.loc).toBe(`data-live-2/${livePack(50)}`);
    expect(await readable(server, log.upload.loc)).toBe(true);
  });

  // The boundary. P's cache is still inside its hour, so P posts into data-live-1 a moment before the DELETE,
  // and the release goes with that pack: P was told "stored" and the pack is gone. This needs the sweep's
  // instant to be 24 h after the successor was made while P learned the newest less than 1 h before the upload
  // (here the sweep's injected `clock` is 24 h ahead of the clock P and the server run on; runSweep takes no
  // instant of its own, so only an injected clock can do this). With one clock, the successor
  // is made after P learned (at C > L), the sweep deletes only from C + 24 h on, and P re-learns by L + 1 h, so
  // the schedule cannot arise: the two cases above are what happens then. This test documents the loss, so a
  // caller that passes a `now` far ahead of the uploaders' clock knows what it risks.
  it("documents a clock fault, not a schedule: a sweep clock injected 24 h ahead of the uploader's and the server's loses a pack", async () => {
    const learnedAt = nowMs - 24 * HOUR - 1000;
    const { server, p } = await schedule({ learnedAt, madeAt: nowMs - 24 * HOUR - 500, clockAt: learnedAt + 10 * 60_000 });
    const { run, log } = await sweepWith(server, p, beforeReleaseDelete);
    expect(log.upload.loc).toBe(`data-live-1/${livePack(50)}`); // P, inside its hour, posted into the old release and was told it is stored
    expect(run.executed.releasesDeleted).toEqual(["data-live-1"]);
    expect(exists(server, log.upload.loc)).toBe(false); // and the release delete took the pack with it
  });
});
