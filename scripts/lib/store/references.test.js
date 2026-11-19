import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coinReferences, windowStart, MAX_BUNDLES_PER_COIN } from "./references.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";
import { readBundle, bundleLoc, bundleKey } from "./bundle.js";
import { RecordShapeError } from "./errors.js";
import { emptyManifest, published, withEntry } from "./manifest.js";
import { packName } from "./packNames.js";
import { SLUG, runOf, folderEnv, writeCoin } from "./recordKit.js";

const AT = "2026-11-18T03:12:40Z";
const TODAY = "2026-11-18";
let env;
let holders;
let ledger;
let flows;
let old1; // a holders bundle of the window that the manifest no longer names
let old2;
let ancient; // outside the window
let copy; // the same pack name as holders' bundle pack, in another release

const locsOf = (w) => [bundleLoc(w.bundleRef), ...w.bundle.packs.map((p) => p.loc)];

beforeAll(async () => {
  env = folderEnv();
  ancient = await writeCoin({ env, day: "2026-10-01", run: runOf(1, 1) });
  old1 = await writeCoin({ env, day: "2026-11-10", run: runOf(2, 1) });
  old2 = await writeCoin({ env, day: "2026-11-11", run: runOf(3, 1), parent: bundleKey(old1.bundleRef) });
  holders = await writeCoin({ env, day: "2026-11-18", run: runOf(4, 1), parent: bundleKey(old2.bundleRef) });
  ledger = await writeCoin({ env, kind: "ledger", day: "2026-11-18", run: runOf(5, 1) });
  flows = await writeCoin({ env, kind: "walletFlows", day: "2026-11-18", run: runOf(6, 1) });
  // A crash and rerun: the same pack name uploaded into the next release. Nothing names it.
  const name = holders.bundleRef.ref.slice(0, holders.bundleRef.ref.lastIndexOf("#"));
  fs.mkdirSync(path.join(env.dir, "data-live-2"), { recursive: true });
  fs.copyFileSync(path.join(env.dir, holders.bundleRef.release, name), path.join(env.dir, "data-live-2", name));
  copy = `data-live-2/${name}`;
});
afterAll(() => env.cleanup());

const manifest = () => {
  let m = emptyManifest(SLUG);
  m = withEntry(m, "holders", published(holders.entry, AT));
  m = withEntry(m, "ledger", published(ledger.entry, AT));
  return withEntry(m, "walletFlows", published(flows.entry, AT));
};
const rowOf = (w, day, part = 1) => ({ day, part, bundle: w.entry.bundle });
const allRows = () => [rowOf(ancient, "2026-10-01"), rowOf(old1, "2026-11-10"), rowOf(old2, "2026-11-11"), rowOf(holders, "2026-11-18")];
// What a loader does: only the rows of the window it is asked for.
const inWindow = (rows) => async ({ from, to }) => rows.filter((r) => r.day >= from && r.day <= to);

const args = (over = {}) => ({
  slug: SLUG, today: TODAY,
  loadManifest: async () => manifest(),
  readBundle: (a) => readBundle({ blobs: env.fresh(), ...a }),
  loadIndexRows: inWindow(allRows()),
  ...over,
});

// Synthetic bundles for counting reads: a bundle with no packs, in a pack of its own.
const synthRef = (n) => ({
  ref: `${packName({ cls: "live", kind: "holders", day: "2026-11-18", run: n, attempt: 1, lane: 0, flush: 0 })}#0`,
  release: "data-live-1", packSize: 9, headerSha256: "a".repeat(64), sha256: n.toString(16).padStart(64, "0"),
});

describe("references one coin still needs (4.3, first paragraph)", () => {
  it("a coin with three kinds and index rows of the adoption window returns exactly the expected locations", async () => {
    const r = await coinReferences(args());
    expect(r.status).toBe("ok");
    const expected = new Set([...locsOf(holders), ...locsOf(ledger), ...locsOf(flows), ...locsOf(old1), ...locsOf(old2)]);
    expect([...r.locations].sort()).toEqual([...expected].sort());
    expect(r.locations.has(locsOf(ancient)[0])).toBe(false);
  });

  it("says why each location is needed", async () => {
    const r = await coinReferences(args());
    expect(r.why.get(bundleLoc(ledger.bundleRef))).toEqual(["manifest:ledger:bundle"]);
    expect(r.why.get(bundleLoc(old1.bundleRef))).toEqual(["index:2026-11-10:bundle"]);
    expect(r.why.get(bundleLoc(holders.bundleRef))).toEqual(expect.arrayContaining(["manifest:holders:bundle", "index:2026-11-18:bundle"]));
    expect(r.why.get(holders.bundle.packs[0].loc)).toEqual(expect.arrayContaining(["manifest:holders:refs"]));
    for (const reasons of r.why.values()) expect(reasons).toEqual([...new Set(reasons)].sort());
  });

  it("a pack copy with the same name in another release is not in the set", async () => {
    const r = await coinReferences(args());
    expect(copy).toMatch(/^data-live-2\//);
    expect(r.locations.has(copy)).toBe(false);
  });

  it("asks the loader for the window only, today included", async () => {
    let asked;
    await coinReferences(args({ loadIndexRows: async (w) => { asked = w; return []; } }));
    expect(asked).toEqual({ from: windowStart(TODAY), to: TODAY });
    expect(asked.from).toBe("2026-11-03");
    expect(ADOPTION_WINDOW_DAYS).toBe(16);
  });

  describe("review S3: the bundle bound is true and enforced", () => {
    it("16 days with 3 rows per day read at most 19 bundles: the newest row of each day plus the three entries", async () => {
      const reads = [];
      const rows = [];
      for (let d = 3; d <= 18; d++) {
        for (let part = 1; part <= 3; part++) rows.push({ day: `2026-11-${String(d).padStart(2, "0")}`, part, bundle: synthRef(d * 10 + part) });
      }
      const r = await coinReferences(args({
        loadIndexRows: inWindow(rows),
        readBundle: (a) => (a.expect ? readBundle({ blobs: env.fresh(), ...a }) : (reads.push(a.bundleRef), Promise.resolve({ packs: [] }))),
      }));
      expect(r.status).toBe("ok");
      expect(reads).toHaveLength(16);
      // Only the newest part (3) of each day was read, never part 1 or 2.
      expect(new Set(reads.map((b) => parseInt(b.sha256, 16) % 10))).toEqual(new Set([3]));
      expect(reads.length + 3).toBe(MAX_BUNDLES_PER_COIN);
      expect(MAX_BUNDLES_PER_COIN).toBe(19);
    });

    it("a row outside the window is a loader bug and throws, it is not folded into unreadable", async () => {
      await expect(coinReferences(args({ loadIndexRows: async () => allRows() }))).rejects.toThrow(RangeError);
      await expect(coinReferences(args({ loadIndexRows: async () => allRows() }))).rejects.toThrow(/outside the window/);
    });

    it("two rows for one day and part are ambiguous: unreadable", async () => {
      const r = await coinReferences(args({ loadIndexRows: async () => [rowOf(old1, "2026-11-10"), rowOf(old2, "2026-11-10")] }));
      expect(r).toMatchObject({ status: "unreadable", stage: "index" });
    });

    it("index rows belong to the holders kind: a row's bundle in a ledger pack is unreadable", async () => {
      const r = await coinReferences(args({ loadIndexRows: async () => [rowOf(ledger, "2026-11-10")] }));
      expect(r).toMatchObject({ status: "unreadable", stage: "index" });
    });
  });

  it("does not mutate what it was given", async () => {
    const m = manifest();
    const rows = allRows();
    const f = JSON.stringify([m, rows]);
    await coinReferences(args({ loadManifest: async () => m, loadIndexRows: inWindow(rows) }));
    expect(JSON.stringify([m, rows])).toBe(f);
  });

  describe("(j) a coin that cannot be read is unreadable, never a partial set", () => {
    it("manifest that does not load", async () => {
      const r = await coinReferences(args({ loadManifest: async () => { throw new SyntaxError("Unexpected token <"); } }));
      expect(r).toMatchObject({ status: "unreadable", slug: SLUG, stage: "manifest" });
      expect(r.reason).toMatch(/Unexpected token/);
      expect(r.locations).toBeUndefined();
    });
    it("review M3: a manifest with a wrong-case kind is unreadable, not 0 locations", async () => {
      const m = JSON.parse(JSON.stringify(manifest()));
      m.entries.Holders = m.entries.holders;
      delete m.entries.holders;
      const r = await coinReferences(args({ loadManifest: async () => m }));
      expect(r).toMatchObject({ status: "unreadable", stage: "manifest", errorName: "RecordShapeError" });
      expect(r.locations).toBeUndefined();
    });
    it("a manifest of another coin, or without entries", async () => {
      expect((await coinReferences(args({ loadManifest: async () => emptyManifest("other") }))).status).toBe("unreadable");
      expect((await coinReferences(args({ loadManifest: async () => ({ schema: 1, slug: SLUG }) }))).status).toBe("unreadable");
    });
    it("a bundle named by a manifest entry", async () => {
      const r = await coinReferences(args({
        readBundle: (a) => (a.kind === "ledger" ? Promise.reject(new Error("pack not found")) : readBundle({ blobs: env.fresh(), ...a })),
      }));
      expect(r).toMatchObject({ status: "unreadable", stage: "bundle", kind: "ledger" });
      expect(r.reason).toMatch(/pack not found/);
      expect(r.locations).toBeUndefined();
    });
    it("a bundle named by an index row", async () => {
      const r = await coinReferences(args({
        readBundle: (a) => (a.bundleRef === old2.entry.bundle ? Promise.reject(new Error("gone")) : readBundle({ blobs: env.fresh(), ...a })),
      }));
      expect(r).toMatchObject({ status: "unreadable", stage: "bundle", day: "2026-11-11" });
    });
    it("a bundle whose bytes were altered", async () => {
      const bad = { ...old1.entry.bundle, sha256: "0".repeat(64) };
      const r = await coinReferences(args({ loadIndexRows: inWindow([{ ...rowOf(old1, "2026-11-10"), bundle: bad }]) }));
      expect(r).toMatchObject({ status: "unreadable", stage: "bundle" });
    });
    it("the index", async () => {
      const r = await coinReferences(args({ loadIndexRows: async () => { throw new Error("index file does not parse"); } }));
      expect(r).toMatchObject({ status: "unreadable", stage: "index" });
      expect(r.reason).toMatch(/index file/);
    });
    it("an index row that is not a row", async () => {
      const r = await coinReferences(args({ loadIndexRows: async () => [{ day: "2026-11-18" }] }));
      expect(r).toMatchObject({ status: "unreadable", stage: "index" });
    });
  });

  describe("review M4: programming errors are thrown, not folded into unreadable", () => {
    it.each([[TypeError, "a TypeError"], [ReferenceError, "a ReferenceError"], [RangeError, "a RangeError"]])("%s from readBundle", async (E) => {
      await expect(coinReferences(args({ readBundle: async () => { throw new E("bug"); } }))).rejects.toThrow(E);
    });
    it("from a loader too", async () => {
      await expect(coinReferences(args({ loadManifest: async () => { null.x; } }))).rejects.toThrow(TypeError);
      await expect(coinReferences(args({ loadIndexRows: async () => { throw new TypeError("bug"); } }))).rejects.toThrow(TypeError);
    });
  });

  it("a manifest with no entries and no rows needs nothing and is readable", async () => {
    const r = await coinReferences(args({ loadManifest: async () => emptyManifest(SLUG), loadIndexRows: async () => [] }));
    expect(r.status).toBe("ok");
    expect(r.locations.size).toBe(0);
  });

  it("an index row of the wrong shape is a shape error, named", async () => {
    const r = await coinReferences(args({ loadIndexRows: async () => [{ day: "2026-11-18", part: 0, bundle: holders.entry.bundle }] }));
    expect(r.errorName).toBe(RecordShapeError.name);
  });
});
