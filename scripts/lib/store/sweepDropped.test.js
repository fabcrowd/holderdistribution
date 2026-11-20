// The sweep against real packs, on the folder backend and on the release backend (fake
// server): a coin written through packItemStore night after night drops old references as
// its days leave the horizon, and the sweep removes exactly the packs nothing names any
// more while every current reference still reads (owed by the table slice, design 4.3 and
// 10(f)). Also the copy of a pack name in another release (blobStore R1): the unreferenced
// copy goes, the referenced one stays and still reads through its pack table.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderBackend } from "./blobStoreFolder.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { createPackItemStore } from "./packItemStore.js";
import { packName } from "./packNames.js";
import { Harness } from "./storeTestKit.js";
import { runSweep } from "./sweep.js";
import { dayBefore } from "./sweepRules.js";
import { TODAY, ok, backendOn, sweepArgs } from "./sweepKit.js";

const T = 60000;
const OLD = new Date(`${dayBefore(TODAY, 30)}T12:00:00Z`);
// Items are put through the view of the coin, so each pack's header lists it (the writer computes the list).
const META = { class: "live", kind: "holders" };
const dirs = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const BACKENDS = {
  folder() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
    dirs.push(dir);
    return {
      make: (o = {}) => folderBackend(dir, { assetLimit: o.assetLimit ?? 900 }),
      // A folder file's age is its modification time.
      age() {
        for (const tag of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, tag))) fs.utimesSync(path.join(dir, tag, f), OLD, OLD);
      },
    };
  },
  release() {
    const server = createFakeReleaseServer();
    server.clock.t = OLD.getTime(); // everything uploaded now is 30 days old
    return { make: (o = {}) => backendOn(server, { assetLimit: o.assetLimit ?? 900 }), age() {} };
  },
};

const refsIn = (index) => new Set(JSON.stringify(index).match(/p\.live\.holders\.[0-9-]+\.r\d+a\d+\.l\d+f\d+\.hdb(?=#\d+)/g));
const nameFor = (run) => (flush) => packName({ cls: "live", kind: "holders", day: "2026-10-01", run, attempt: 1, lane: 0, flush });

for (const [label, backend] of Object.entries(BACKENDS)) {
  describe(`the sweep on real packs, ${label} backend`, () => {
    it("removes the packs a newer state no longer names; every current reference still reads", async () => {
      const env = backend();
      const blobs = env.make();
      const h = new Harness({ rowsPerBucket: 3, historyDays: 12, ageMarginDays: 3, ageSpreadDays: 2 });
      const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
      let rows = [];
      for (let night = 1; night <= 25; night++) {
        const raw = createPackItemStore({ blobs, nameFor: nameFor(night), packs: rows, meta: META, targetBytes: 1 << 20 });
        h.store = raw.forCoin("example");
        await h.night(night, Object.fromEntries(keys.map((k, i) => [k, night * 10 + i])));
        rows = [...rows, ...(await raw.close()).packs];
      }
      env.age();
      const named = refsIn(h.index);
      const byName = new Map(rows.map((r) => [r.name, r.loc]));
      const unnamed = rows.filter((r) => !named.has(r.name)).map((r) => r.loc);
      expect(h.dropped.length, "the horizon dropped parts").toBeGreaterThan(0);
      expect(unnamed.length, "some packs are no longer named").toBeGreaterThan(0);
      const reader = () => createPackItemStore({ blobs: env.make(), nameFor: () => { throw new Error("read-only"); }, packs: rows });

      h.store = reader();
      await h.verifyAll({ versions: [h.versions.at(-1)] });

      const locs = [...named].map((n) => byName.get(n));
      const run = await runSweep(sweepArgs(blobs, { coins: ["example"], referencesFor: async () => ok("example", locs) }));
      expect(run.executed.deleted.sort()).toEqual(unnamed.sort());
      for (const loc of unnamed) expect(await env.make().exists(loc), loc).toBe(false);
      for (const loc of locs) expect(await env.make().exists(loc), loc).toBe(true);

      h.store = reader();
      await h.verifyAll({ versions: [h.versions.at(-1)] });
      const goneRef = h.dropped.find((ref) => unnamed.includes(byName.get(ref.slice(0, ref.lastIndexOf("#")))));
      expect(goneRef, "a dropped reference points into a swept pack").toBeDefined();
      expect(await h.store.has(goneRef)).toBe(false);
      expect(run.summary.byClass.live.deleted).toBe(unnamed.length);
    }, T);

    it("the copy of a pack name in another release that no reference names goes; the referenced copy stays and reads through its pack table", async () => {
      const env = backend();
      const first = createPackItemStore({ blobs: env.make(), nameFor: nameFor(7), meta: META });
      const ref = await first.forCoin("example").put(Buffer.from("balance=100"));
      const { packs } = await first.close();
      const [row] = packs;
      // A crash and rerun: a second process, finding the first release full, stores the same name in the next one.
      const copy = createPackItemStore({ blobs: env.make({ assetLimit: 1 }), nameFor: nameFor(7), meta: META });
      await copy.forCoin("example").put(Buffer.from("balance=999"));
      const second = (await copy.close()).packs[0];
      expect(second.loc).not.toBe(row.loc);
      expect(second.name).toBe(row.name);
      env.age();

      const blobs = env.make();
      const run = await runSweep(sweepArgs(blobs, { coins: ["example"], referencesFor: async () => ok("example", [row.loc]), currentReleases: { live: "data-live-1", hist: "data-hist-1", events: "data-events-1", site: "data-site-1" } }));
      expect(run.executed.deleted).toEqual([second.loc]);
      // data-live-2 is now empty but is the newest release of the series: it stays (a lane may be about to upload into it)
      expect(run.executed.releasesDeleted).toEqual([]);
      expect(run.plan.summary.releasesKept).toEqual([expect.objectContaining({ tag: "data-live-2", code: "newest-release" })]);
      expect(await env.make().exists(second.loc)).toBe(false);
      const reader = createPackItemStore({ blobs: env.make(), nameFor: () => { throw new Error("read-only"); }, packs: [row] });
      expect((await reader.get(ref)).toString()).toBe("balance=100");
    }, T);
  });
}
