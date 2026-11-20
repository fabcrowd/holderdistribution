import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, afterAll } from "vitest";
import {
  BUNDLE_SCHEMA, buildBundle, serializeBundle, parseBundle, validateBundle, bundleKey, bundleLoc,
  referencedPacks, readBundle, bundleItems, bundleRefOf, writeBundle,
} from "./bundle.js";
import { RecordSyntaxError, RecordSchemaError, RecordShapeError, BundleBuildError, BundleReadError, BundleVerifyError } from "./errors.js";
import { createPackItemStore } from "./packItemStore.js";
import { packName } from "./packNames.js";
import { SLUG, sha, runOf, folderEnv, releaseEnv, writeCoin } from "./recordKit.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const envs = [];
const track = (env) => { envs.push(env); return env; };
afterAll(() => envs.forEach((e) => e.cleanup()));

describe("bundle: build, serialize, parse, validate", () => {
  it("round-trips with stable bytes whatever the key order of the input", async () => {
    const env = folderEnv();
    track(env);
    const { bundle } = await writeCoin({ env });
    const bytes = serializeBundle(bundle);
    const back = parseBundle(bytes);
    expect(back).toEqual(bundle);
    expect(serializeBundle(back).equals(bytes)).toBe(true);
    const shuffled = Object.fromEntries(Object.entries(clone(bundle)).reverse());
    shuffled.run = { workflow: bundle.run.workflow, id: bundle.run.id, attempt: bundle.run.attempt };
    expect(serializeBundle(buildBundle(shuffled)).equals(bytes)).toBe(true);
    expect(bundle.schema).toBe(BUNDLE_SCHEMA);
  });

  it("build does not mutate its argument and sorts the pack rows", async () => {
    const env = folderEnv();
    track(env);
    const { bundle } = await writeCoin({ env });
    const input = { ...clone(bundle), packs: clone(bundle.packs).reverse() };
    delete input.schema;
    const frozen = JSON.stringify(input);
    const built = buildBundle(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(built.packs.map((p) => p.name)).toEqual(bundle.packs.map((p) => p.name));
  });

  it("is identified by its full key <release>/<pack name>#<item id>@<sha256>, and its location from the release", async () => {
    const env = folderEnv();
    track(env);
    const { bundleRef } = await writeCoin({ env });
    const name = bundleRef.ref.slice(0, bundleRef.ref.lastIndexOf("#"));
    expect(bundleKey(bundleRef)).toBe(`${bundleRef.release}/${bundleRef.ref}@${bundleRef.sha256}`);
    expect(bundleLoc(bundleRef)).toBe(`${bundleRef.release}/${name}`);
  });

  describe("adversarial input gives a named error that names the coin and kind", () => {
    let good;
    it("setup", async () => {
      const env = folderEnv();
      good = clone((await writeCoin({ env })).bundle);
      env.cleanup();
    });

    const mutate = (fn) => { const b = clone(good); fn(b); return b; };
    const shape = [
      ["a missing slug", (b) => { delete b.slug; }],
      ["a missing run", (b) => { delete b.run; }],
      ["a missing usage", (b) => { delete b.usage; }],
      ["a missing stateIndex", (b) => { delete b.stateIndex; }],
      ["a missing packs", (b) => { delete b.packs; }],
      ["slug of the wrong type", (b) => { b.slug = 7; }],
      ["an unknown kind", (b) => { b.kind = "nightly"; }],
      ["a day that is not a day", (b) => { b.day = "2026-02-31"; }],
      ["run.id of the wrong type", (b) => { b.run.id = "1"; }],
      ["run.attempt zero", (b) => { b.run.attempt = 0; }],
      ["blobs as an array", (b) => { b.blobs = []; }],
      ["a blob that is not an item reference", (b) => { b.blobs["x.json"] = "nope"; }],
      ["a table descriptor that is not an object", (b) => { b.tables.acct = 3; }],
      ["an extra field (the policy: none allowed)", (b) => { b.extra = 1; }],
      ["an extra field inside run", (b) => { b.run.host = "x"; }],
      ["a parent in the old <pack name>#<slug> form", (b) => { b.parent = "p.live.holders.2026-11-17.r1a1.l0f0.hdb#example"; }],
      ["a parent key with a short hash", (b) => { b.parent = "data-live-1/p.live.holders.2026-11-17.r1a1.l0f0.hdb#0@aaaa"; }],
      ["a parent key in a hist release", (b) => { b.parent = "data-live-1/p.live.holders.2026-11-17.r1a1.l0f0.hdb#0@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".replace("data-live-1", "data-hist-1"); }],
      ["a __proto__ blob path", (b) => { b.blobs = JSON.parse('{"__proto__": "p.live.holders.2026-11-18.r1a1.l0f0.hdb#0"}'); }],
      ["a constructor table name", (b) => { b.tables = JSON.parse('{"constructor": {}}'); }],
      ["a prototype usage key", (b) => { b.usage.run = JSON.parse('{"prototype": 1}'); }],
      ["pack rows out of order", (b) => { b.packs.reverse(); }],
      ["a pack row for a pack nothing names", (b) => { b.packs.push({ ...b.packs[0], name: "p.live.holders.2026-11-19.r9a1.l0f0.hdb", loc: "data-live-1/p.live.holders.2026-11-19.r9a1.l0f0.hdb" }); }],
      ["a pack row whose location is another pack", (b) => { b.packs[0].loc = b.packs[1].loc; }],
      ["a pack row with a short sha256", (b) => { b.packs[0].sha256 = "abc"; }],
      ["usage with a negative count", (b) => { b.usage.run.providerA = -1; }],
      ["usage month that is not the day's month", (b) => { b.usage.month = "2026-10"; }],
    ];
    it.each(shape)("%s", (_, fn) => {
      const bad = mutate(fn);
      expect(() => validateBundle(bad, { slug: SLUG, kind: "holders" })).toThrow(RecordShapeError);
      try { validateBundle(bad, { slug: SLUG, kind: "holders" }); } catch (e) { expect(e.message).toMatch(/bundle/); expect(e.message).toMatch(/example/); }
    });

    it("an unknown schema is a named error", () => {
      expect(() => parseBundle(JSON.stringify({ ...good, schema: 2 }), { slug: SLUG })).toThrow(RecordSchemaError);
      expect(() => parseBundle(JSON.stringify({ ...good, schema: "1" }), { slug: SLUG })).toThrow(RecordSchemaError);
      expect(() => parseBundle(JSON.stringify({ slug: SLUG }), { slug: SLUG })).toThrow(RecordSchemaError);
    });

    it("bytes that are not JSON, or not an object, are named errors", () => {
      expect(() => parseBundle("{nope", { slug: SLUG })).toThrow(RecordSyntaxError);
      expect(() => parseBundle("[]", { slug: SLUG })).toThrow(RecordShapeError);
      expect(() => parseBundle("null", { slug: SLUG })).toThrow(RecordShapeError);
    });

    it("two references into packs without a row (only the bundle's own pack may lack one)", () => {
      const bad = mutate((b) => { b.blobs["y.json"] = "p.live.holders.2026-11-18.r1a1.l5f0.hdb#0"; });
      expect(() => validateBundle(bad, { slug: SLUG })).toThrow(RecordShapeError);
    });
  });

  it("build refuses a mismatch between the context and the content", async () => {
    const env = folderEnv();
    track(env);
    const { bundle } = await writeCoin({ env });
    expect(() => validateBundle(bundle, { slug: "other" })).toThrow(RecordShapeError);
    expect(() => validateBundle(bundle, { slug: SLUG, kind: "ledger" })).toThrow(RecordShapeError);
  });
});

describe.each([["folder", folderEnv], ["release", releaseEnv]])("bundle through packItemStore on the %s backend", (_, makeEnv) => {
  const env = track(makeEnv());
  let written;
  it("is written as an item, and every reference resolves from a fresh process state with the bundle's own rows", async () => {
    written = await writeCoin({ env });
    expect(written.bundleRef.sha256).toBe(sha(serializeBundle(written.bundle)));

    // Fresh process state: new backend object, a bundle read from the manifest entry only.
    const blobs = env.fresh();
    const before = blobs.stats ? blobs.stats().core : 0;
    const got = await readBundle({ blobs, slug: SLUG, kind: "holders", bundleRef: written.entry.bundle, expect: written.entry });
    expect(got).toEqual(written.bundle);

    const items = bundleItems({ blobs, bundle: got, bundleRef: written.entry.bundle });
    const refs = [...Object.values(got.blobs), got.stateIndex, got.tables.acct.buckets[0].base];
    expect(refs).toHaveLength(4);
    for (const ref of refs) expect((await items.get(ref)).length).toBeGreaterThan(100);
    if (blobs.stats) expect(blobs.stats().core - before).toBe(0);
  });

  it("reads the bundle with at most two range reads and no listing", async () => {
    const real = env.fresh();
    let reads = 0;
    let lists = 0;
    const blobs = { ...real, readRange: (...a) => { reads++; return real.readRange(...a); }, list: (...a) => { lists++; return real.list(...a); }, find: (...a) => { lists++; return real.find(...a); } };
    const before = real.stats ? real.stats().core : 0;
    // The cross-check of the items' labels reads one more header per named pack (bundleCoinCheck.test.js); the bundle alone is two.
    await readBundle({ blobs, slug: SLUG, kind: "holders", bundleRef: written.entry.bundle, crossCheck: false });
    expect(reads).toBeLessThanOrEqual(2);
    expect(lists).toBe(0);
    if (real.stats) expect(real.stats().core - before).toBe(0);
  });

  it("referencedPacks returns exactly the rows of the packs the references name, and does not count the own pack", () => {
    const rows = referencedPacks(written.bundle);
    expect(rows.map((r) => r.name).sort()).toEqual([...new Set(Object.values(written.bundle.blobs).concat(written.bundle.stateIndex, written.bundle.tables.acct.buckets[0].base).map((r) => r.slice(0, r.lastIndexOf("#"))))].filter((n) => n !== written.bundleRef.ref.slice(0, written.bundleRef.ref.lastIndexOf("#"))).sort());
    rows.push({ name: "mutated" });
    expect(referencedPacks(written.bundle).some((r) => r.name === "mutated")).toBe(false);
  });

  it("fails verification when the entry's hash is not the bundle's", async () => {
    const bad = { ...written.entry.bundle, sha256: sha("something else") };
    await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "holders", bundleRef: bad })).rejects.toThrow(BundleVerifyError);
  });

  it("fails when the entry's day, run or parent differ from the bundle's, or it is another coin's or kind's", async () => {
    const e = written.entry;
    for (const expect_ of [{ ...e, day: "2026-11-17" }, { ...e, run: runOf(2, 1) }, { ...e, parent: "data-live-1/p.live.holders.2026-11-17.r1a1.l0f0.hdb#0@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]) {
      await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "holders", bundleRef: e.bundle, expect: expect_ })).rejects.toThrow(BundleVerifyError);
    }
    await expect(readBundle({ blobs: env.fresh(), slug: "other", kind: "holders", bundleRef: e.bundle })).rejects.toThrow(BundleVerifyError);
    await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "ledger", bundleRef: e.bundle })).rejects.toThrow(/ledger/);
  });

  it("names the coin and kind when the pack is missing or has another size", async () => {
    const wrongSize = { ...written.entry.bundle, packSize: written.entry.bundle.packSize + 1 };
    await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "holders", bundleRef: wrongSize })).rejects.toThrow(BundleReadError);
    await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "holders", bundleRef: wrongSize })).rejects.toThrow(/example.*holders/);
    const elsewhere = { ...written.entry.bundle, release: "data-live-9" };
    await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "holders", bundleRef: elsewhere })).rejects.toThrow(BundleReadError);
  });
});

describe("a bundle whose stored bytes were altered", () => {
  it("fails on the folder backend", async () => {
    const env = folderEnv();
    track(env);
    const { entry } = await writeCoin({ env });
    const file = path.join(env.dir, entry.bundle.release, entry.bundle.ref.slice(0, entry.bundle.ref.lastIndexOf("#")));
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 3] ^= 0x01; // inside the last item, which is the bundle
    fs.writeFileSync(file, bytes);
    await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "holders", bundleRef: entry.bundle })).rejects.toThrow(BundleReadError);
  });

  it("fails on the release backend", async () => {
    const env = track(releaseEnv());
    const { entry } = await writeCoin({ env });
    const name = entry.bundle.ref.slice(0, entry.bundle.ref.lastIndexOf("#"));
    const asset = env.server.release(entry.bundle.release).assets.find((a) => a.name === name);
    asset.bytes[asset.bytes.length - 3] ^= 0x01;
    await expect(readBundle({ blobs: env.fresh(), slug: SLUG, kind: "holders", bundleRef: entry.bundle })).rejects.toThrow(BundleReadError);
  });
});

describe("writing a bundle", () => {
  it("refuses a reference into a closed pack that has no row, naming the pack", async () => {
    const env = folderEnv();
    track(env);
    const nameFor = (f) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 1, attempt: 1, lane: 0, flush: f });
    const s0 = createPackItemStore({ blobs: env.blobs, nameFor, targetBytes: 1 << 20 });
    const lost = await s0.put(Buffer.from("x".repeat(200)));
    await s0.close();
    const s1 = createPackItemStore({ blobs: env.blobs, nameFor: (f) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: 1, attempt: 1, lane: 1, flush: f }), targetBytes: 1 << 20 });
    const bundle = buildBundle({ slug: SLUG, kind: "holders", day: "2026-11-18", run: runOf(), parent: null, usage: { day: "2026-11-18", month: "2026-11", run: {}, dayTotal: {}, monthTotal: {} }, blobs: { "a.json": lost }, tables: {}, stateIndex: null, packs: [] });
    await expect(writeBundle(s1, bundle)).rejects.toThrow(BundleBuildError);
    await expect(writeBundle(s1, bundle)).rejects.toThrow(/example.*holders/);
  });

  it("bundleRefOf refuses a pack that is not in the closed rows", () => {
    expect(() => bundleRefOf({ ref: "p.live.holders.2026-11-18.r1a1.l0f0.hdb#0", sha256: sha("x") }, [])).toThrow(BundleBuildError);
  });
});
