// The blob store's operations on both backends through one table of expectations.
// Release-only behavior (roll-over against the hard limit, request costs, faults) is in
// blobStoreRelease.test.js.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { memorySink, fileSink, StoreNameError, StoreKeepError, StoreNotFoundError, StoreNameTakenError } from "./blobStore.js";
import { folderBackend } from "./blobStoreFolder.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { packName, listName } from "./packNames.js";
import { createPackItemStore, PackUnknownError } from "./packItemStore.js";
import { genBytes } from "./pack.test.js";

const T = 60000;
const MiB = 1024 * 1024;
const live = (flush, lane = 0) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 9, attempt: 1, lane, flush });
const keepPack = packName({ cls: "keep", kind: "holders", day: "2026-11-18", run: 9, attempt: 1, lane: 0, flush: 0 });

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), "blobs-"));

const BACKENDS = {
  folder: async (opts = {}) => {
    const dir = opts.dir ?? (await tmpDir());
    const make = (o = {}) => folderBackend(dir, { assetLimit: o.assetLimit ?? opts.assetLimit ?? 5 });
    return { store: make(), dir, again: make };
  },
  release: async (opts = {}) => {
    const server = opts.server ?? createFakeReleaseServer(opts.fake);
    const make = (o = {}) => releaseBackend({ owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t, sleep: async (ms) => { server.clock.t += ms; }, assetLimit: o.assetLimit ?? opts.assetLimit ?? 5 });
    return { store: make(), server, again: make };
  },
};

for (const [label, make] of Object.entries(BACKENDS)) {
  describe(`blob store on the ${label} backend`, () => {
    it("upload, exists, readRange, stat, find, list, delete: all by location", async () => {
      const { store } = await make();
      const bytes = genBytes(5000, 1);
      expect(await store.find(live(0))).toEqual([]);
      const up = await store.upload(live(0), bytes);
      expect(up).toEqual({ name: live(0), size: 5000, loc: `data-live-1/${live(0)}` });
      expect(await store.exists(up.loc)).toBe(true);
      expect((await store.readRange(up.loc, 100, 20)).equals(bytes.subarray(100, 120))).toBe(true);
      expect(await store.stat(up.loc)).toEqual({ size: 5000, loc: up.loc });
      store.refresh("live");
      expect((await store.find(live(0))).map((e) => e.loc)).toEqual([up.loc]);
      const listed = await store.list("live");
      expect(listed.map((x) => [x.name, x.size, x.loc])).toEqual([[live(0), 5000, up.loc]]);
      expect(typeof listed[0].createdAt).toBe("string");
      await store.delete(up.loc);
      expect(await store.exists(up.loc)).toBe(false);
      expect(await store.stat(up.loc)).toBe(null);
      await expect(store.readRange(up.loc, 0, 1)).rejects.toBeInstanceOf(StoreNotFoundError);
      await expect(store.stat(live(0))).rejects.toBeInstanceOf(StoreNameError); // a bare name is not a location
    }, T);

    it("a stream source uploads the same bytes", async () => {
      const { store } = await make();
      const bytes = genBytes(70_000, 2);
      const source = { size: bytes.length, async *open() { for (let i = 0; i < bytes.length; i += 10_000) yield bytes.subarray(i, i + 10_000); } };
      const { loc } = await store.upload(live(1), source);
      const sink = memorySink();
      await store.download(loc, sink);
      expect(sink.bytes().equals(bytes)).toBe(true);
    }, T);

    it("refuses names the store does not own and the keep class", async () => {
      const { store } = await make();
      const k = await store.upload(keepPack, genBytes(10));
      const l = await store.upload(listName("b".repeat(64)), genBytes(10));
      await expect(store.delete("data-live-1/notes.txt")).rejects.toBeInstanceOf(StoreNameError);
      await expect(store.delete(`../${live(0)}`)).rejects.toBeInstanceOf(StoreNameError);
      await expect(store.delete(`data-hist-1/${live(0)}`)).rejects.toBeInstanceOf(StoreNameError);
      await expect(store.upload("notes.txt", genBytes(1))).rejects.toBeInstanceOf(StoreNameError);
      await expect(store.delete(k.loc)).rejects.toBeInstanceOf(StoreKeepError);
      await expect(store.delete(l.loc)).rejects.toBeInstanceOf(StoreKeepError);
      expect(await store.exists(k.loc)).toBe(true);
    }, T);

    it("a stored location is never replaced: equal bytes are 'already stored', other bytes throw", async () => {
      const { store, again } = await make();
      const first = await store.upload(live(2), Buffer.from("AAAA"));
      expect(await again().upload(live(2), Buffer.from("AAAA"))).toEqual(first);
      await expect(again().upload(live(2), Buffer.from("BBBB"))).rejects.toBeInstanceOf(StoreNameTakenError);
      await expect(again().upload(live(2), Buffer.from("CCCCC"))).rejects.toBeInstanceOf(StoreNameTakenError);
      expect((await store.readRange(first.loc, 0, 4)).toString()).toBe("AAAA");
      expect((await store.stat(first.loc)).size).toBe(4);
    }, T);

    it("a rerun that reuses a pack name in the same release throws and never serves the first run's bytes", async () => {
      const { again } = await make({ assetLimit: 900 });
      const nameFor = () => live(7);
      const mk = (packs) => createPackItemStore({ blobs: again(), nameFor, packs, targetBytes: 1 << 30 });
      let s = mk();
      const r1 = await s.put(Buffer.from("balance=100"));
      const { packs } = await s.close();
      s = mk();
      const r2 = await s.put(Buffer.from("balance=999"));
      await expect(s.close()).rejects.toBeInstanceOf(StoreNameTakenError);
      await expect(s.get(r2)).rejects.toThrow(/upload failed/);
      expect((await mk(packs).get(r1)).toString()).toBe("balance=100");
    }, T);

    it("R1: the same name in two releases is two objects; find returns both and nothing picks one", async () => {
      const { again } = await make();
      const a = await again({ assetLimit: 1 }).upload(live(3), Buffer.from("OLD1"));
      const b = await again({ assetLimit: 1 }).upload(live(3), Buffer.from("NEW1"));
      expect(b.loc).not.toBe(a.loc);
      const reader = again();
      expect((await reader.readRange(a.loc, 0, 4)).toString()).toBe("OLD1");
      expect((await reader.readRange(b.loc, 0, 4)).toString()).toBe("NEW1");
      expect((await reader.find(live(3))).map((e) => e.loc).sort()).toEqual([a.loc, b.loc].sort());
      // A ref of that pack name with no pack table is not resolved to either of them.
      const s = createPackItemStore({ blobs: reader, nameFor: () => live(3) });
      await expect(s.get(`${live(3)}#0`)).rejects.toBeInstanceOf(PackUnknownError);
    }, T);

    it("S-A: after a sweep deletes run 1's copy, run 1's ref with no table throws and never reads run 2's bytes", async () => {
      const { again } = await make();
      const nameFor = () => live(7);
      let s = createPackItemStore({ blobs: again({ assetLimit: 1 }), nameFor });
      const ref = await s.put(Buffer.from("V1"));
      const t1 = await s.close();
      s = createPackItemStore({ blobs: again({ assetLimit: 1 }), nameFor });
      await s.put(Buffer.from("V2"));
      const t2 = await s.close();
      expect(t2.packs[0].loc).not.toBe(t1.packs[0].loc);
      expect((await createPackItemStore({ blobs: again(), nameFor, packs: t1.packs }).get(ref)).toString()).toBe("V1");
      const sweeper = again();
      await sweeper.find(live(7));
      await sweeper.delete(t1.packs[0].loc);
      const noTable = createPackItemStore({ blobs: again(), nameFor });
      await expect(noTable.get(ref)).rejects.toBeInstanceOf(PackUnknownError);
      // Through run 1's table the swept location is not found, never run 2's bytes.
      await expect(createPackItemStore({ blobs: again(), nameFor, packs: t1.packs }).get(ref)).rejects.toThrow(/not found/);
    }, T);

    it("R2: the pack table records the location the upload returned, and every ref of a closed store reads", async () => {
      const { again } = await make({ assetLimit: 2 });
      const blobs = again();
      const s = createPackItemStore({ blobs, nameFor: (f) => live(20 + f), targetBytes: 64 });
      const items = Array.from({ length: 12 }, (_, i) => genBytes(40, 300 + i));
      const refs = [];
      for (const b of items) refs.push(await s.put(b));
      const { packs } = await s.close();
      expect(packs.length).toBeGreaterThan(2); // several releases at a limit of 2
      for (const p of packs) {
        expect(await blobs.stat(p.loc)).toEqual({ size: p.size, loc: p.loc });
        expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(new Set(packs.map((p) => p.loc.split("/")[0])).size).toBeGreaterThan(1);
      const reader = createPackItemStore({ blobs: again(), nameFor: () => live(99), packs: JSON.parse(JSON.stringify(packs)) });
      for (const [i, ref] of refs.entries()) expect((await reader.get(ref)).equals(items[i])).toBe(true);
    }, T);

    it("rolls over to the next release at the asset limit", async () => {
      const { store } = await make();
      const locs = [];
      for (let f = 0; f < 12; f++) locs.push((await store.upload(live(f), genBytes(10, f))).loc);
      const listed = await store.list("live");
      expect(listed).toHaveLength(12);
      expect(listed.map((x) => x.release)).toEqual([...Array(5).fill("data-live-1"), ...Array(5).fill("data-live-2"), ...Array(2).fill("data-live-3")]);
      for (let f = 0; f < 12; f++) expect((await store.readRange(locs[f], 0, 10)).equals(genBytes(10, f))).toBe(true);
    }, T);

    it("processes uploading at once overshoot the limit by at most P - 1", async () => {
      const first = await make();
      for (let f = 0; f < 4; f++) await first.store.upload(live(f), genBytes(10, f));
      const procs = Array.from({ length: 4 }, () => first.again());
      await Promise.all(procs.map((s, p) => Promise.all(Array.from({ length: 6 }, (_, f) => s.upload(live(f, p + 1), genBytes(10, 100 + p * 10 + f))))));
      const per = {};
      for (const x of await first.again().list("live")) per[x.release] = (per[x.release] ?? 0) + 1;
      expect(Object.values(per).reduce((a, b) => a + b)).toBe(4 + 24);
      for (const n of Object.values(per)) expect(n).toBeLessThanOrEqual(5 + procs.length - 1);
    }, T);

    it("parallel-range download equals the upload for sizes 0, 1, one range, 8 ranges + 1, 64 MiB", async () => {
      const { store } = await make({ assetLimit: 900 });
      const rangeBytes = 64 * 1024;
      const sizes = [0, 1, rangeBytes, 8 * rangeBytes + 1, 64 * MiB];
      const dir = await tmpDir();
      for (const [i, size] of sizes.entries()) {
        const bytes = genBytes(size, 40 + i);
        const { loc } = await store.upload(live(i), bytes);
        const rb = size === 64 * MiB ? 8 * MiB : rangeBytes;
        const mem = memorySink();
        await store.download(loc, mem, { rangeBytes: rb });
        expect(mem.bytes().equals(bytes), `size ${size}`).toBe(true);
        const file = path.join(dir, `f${i}`);
        await store.download(loc, fileSink(file), { rangeBytes: rb, parallel: 8 });
        expect((await fs.readFile(file)).equals(bytes), `file size ${size}`).toBe(true);
      }
      await fs.rm(dir, { recursive: true, force: true });
    }, T);
  });
}

describe("folder backend: concurrent uploads of one name (F2)", () => {
  it("different bytes: exactly one stores, the other throws; equal bytes: both get the location", async () => {
    const dir = await tmpDir();
    const r = await Promise.allSettled([folderBackend(dir).upload(live(1), Buffer.from("XXXX")), folderBackend(dir).upload(live(1), Buffer.from("YYYY"))]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const won = r.find((x) => x.status === "fulfilled").value;
    expect(r.find((x) => x.status === "rejected").reason).toBeInstanceOf(StoreNameTakenError);
    const stored = (await folderBackend(dir).readRange(won.loc, 0, 4)).toString();
    expect(["XXXX", "YYYY"]).toContain(stored);
    const same = await Promise.all([folderBackend(dir).upload(live(2), Buffer.from("ZZZZ")), folderBackend(dir).upload(live(2), Buffer.from("ZZZZ"))]);
    expect(same[0].loc).toBe(same[1].loc);
  });
});
