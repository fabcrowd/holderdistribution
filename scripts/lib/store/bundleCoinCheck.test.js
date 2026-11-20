// Real packs carry whose item is whose (bundles are items of type "bundle"), the sweep reads
// the coin list of such a pack, and a bundle read refuses an item that its pack labels with
// another coin (design 2.1 section 7.2, 9.3). Folder and release backends.
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { openPack } from "./pack.js";
import { createPackItemStore } from "./packItemStore.js";
import { packName } from "./packNames.js";
import { packNameOf } from "./itemRef.js";
import { buildBundle, bundleRefOf, readBundle, writeBundle } from "./bundle.js";
import { buildEntry } from "./manifest.js";
import { acceptChain } from "./acceptChain.js";
import { BundleItemCoinError, BundleVerifyError } from "./errors.js";
import { coinsFromHeader, headerCounter } from "./sweepHeaders.js";
import { nextUsage } from "./usage.js";
import { folderEnv, releaseEnv, runOf, writeCoin, writeCoins } from "./recordKit.js";

const envs = [];
const track = (e) => { envs.push(e); return e; };
afterAll(() => envs.forEach((e) => e.cleanup()));
const COIN = (i) => `example-${String(i).padStart(2, "0")}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const DAY = "2026-11-18";
const nameFor = (lane, kind = "holders") => (flush) => packName({ cls: "live", kind, day: DAY, run: 40, attempt: 1, lane, flush });

const headerOf = async (blobs, row) => (await openPack({ name: row.loc, size: row.size, readRange: (o, l) => blobs.readRange(row.loc, o, l) })).header;

// The pack with item `id` relabelled to `slug` in its header, uploaded as a new pack with its own row:
// an item moved under another coin's label by a crafted header.
async function relabelled({ env, row, id, slug, lane }) {
  const bytes = await env.blobs.readRange(row.loc, 0, row.size);
  const hl = bytes.readUInt32BE(4);
  const header = JSON.parse(bytes.subarray(8, 8 + hl).toString("utf8"));
  header.items[id].slug = slug;
  header.slugs = [...new Set(header.items.map((i) => i.slug))].sort();
  const hb = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.write("HDB1", 0, "latin1");
  prefix.writeUInt32BE(hb.length, 4);
  const out = Buffer.concat([prefix, hb, bytes.subarray(8 + hl)]);
  const name = nameFor(lane)(0);
  const up = await env.blobs.upload(name, out);
  return { name, loc: up.loc, size: out.length, sha256: sha(out), headerSha256: sha(out.subarray(0, 8 + hb.length)), items: header.items.length };
}

// A bundle of `slug` naming `refs` (path -> ref) whose pack rows are `rows`.
async function bundleOf({ env, slug, refs, rows, lane = 50 }) {
  const s = createPackItemStore({ blobs: env.blobs, nameFor: nameFor(lane), requireCoin: true });
  const bundle = buildBundle({
    slug, kind: "holders", day: DAY, run: runOf(40), parent: null, usage: nextUsage({ parent: null, day: DAY, used: {} }),
    blobs: refs, tables: {}, stateIndex: null, packs: rows,
  });
  const put = await writeBundle(s.forCoin(slug), bundle);
  const closed = await s.close();
  const bundleRef = bundleRefOf(put, closed.packs);
  return { bundle, bundleRef, entry: buildEntry({ slug, kind: "holders", bundleRef, bundle }), closed };
}

describe("a pack written by the record kit for 16 coins", () => {
  it("lists exactly those coins, holds one bundle item per coin, and the sweep's default reader finds the list", async () => {
    const env = track(folderEnv());
    const slugs = Array.from({ length: 16 }, (_, i) => COIN(i + 1));
    const built = await writeCoins({ env, specs: slugs.map((slug) => ({ slug })) });
    const [own] = built[0].ownRows;
    expect(built[0].ownRows).toHaveLength(1);
    const h = await headerOf(env.fresh(), own);
    expect(h.slugs).toEqual(slugs);
    const bundles = h.items.filter((i) => i.type === "bundle");
    expect(bundles.map((i) => i.slug).sort()).toEqual(slugs);
    expect(h.items.filter((i) => i.type !== "bundle").map((i) => i.slug).sort()).toEqual(slugs); // the coins' own items
    const read = await coinsFromHeader({ blobs: env.fresh(), entry: own, counter: headerCounter() });
    expect(read).toEqual({ coins: slugs }); // no longer "no coin list"
    for (const row of built[0].rows.concat(built[5].rows)) {
      const lane0 = await coinsFromHeader({ blobs: env.fresh(), entry: row, counter: headerCounter() });
      expect(lane0.coins.every((c) => slugs.includes(c))).toBe(true);
    }
  });
});

describe.each([["folder", folderEnv], ["release", releaseEnv]])("the cross-check of a bundle read on the %s backend", (_, makeEnv) => {
  it("passes a bundle whose items are all labelled with its coin, adds no API request, and reads one header per named pack", async () => {
    const env = track(makeEnv());
    const { entry, bundle } = await writeCoin({ env, slug: COIN(1) });
    const real = env.fresh();
    let reads = 0;
    let lists = 0;
    const blobs = { ...real, readRange: (...a) => { reads++; return real.readRange(...a); }, list: (...a) => { lists++; return real.list(...a); }, find: (...a) => { lists++; return real.find(...a); } };
    const seen = [];
    const core = real.stats().core;
    const listed = env.server?.counts.listAssets ?? 0;
    const got = await readBundle({ blobs, slug: COIN(1), kind: "holders", bundleRef: entry.bundle, expect: entry, onItemsChecked: (r) => seen.push(r) });
    expect(got).toEqual(bundle);
    const named = new Set([packNameOf(entry.bundle.ref), ...bundle.packs.map((r) => r.name)]);
    expect(seen).toEqual([{ itemsChecked: 5, itemsCarried: 0, unlabelled: 0, packs: named.size, rangeReads: named.size - 1 }]); // 4 references and the bundle item; the own pack's header was read with the bundle
    expect(reads).toBe(named.size + 1); // the headers, each once, and the bundle item
    expect(lists).toBe(0);
    expect(real.stats().core - core).toBe(0);
    if (env.server) expect((env.server.counts.listAssets ?? 0) - listed).toBe(0);
  });

  it("crossCheck: false is the old read: at most two range reads", async () => {
    const env = track(makeEnv());
    const { entry } = await writeCoin({ env, slug: COIN(1) });
    const real = env.fresh();
    let reads = 0;
    const blobs = { ...real, readRange: (...a) => { reads++; return real.readRange(...a); } };
    await readBundle({ blobs, slug: COIN(1), kind: "holders", bundleRef: entry.bundle, crossCheck: false });
    expect(reads).toBeLessThanOrEqual(2);
  });

  it("refuses an item moved under another coin's label by a crafted header, naming the reference and both coins", async () => {
    const env = track(makeEnv());
    const { bundle, entry } = await writeCoin({ env, slug: COIN(1) });
    const row = bundle.packs.find((r) => r.name === packNameOf(bundle.blobs[`data/${COIN(1)}/a.json`]));
    const id = Number(bundle.blobs[`data/${COIN(1)}/a.json`].split("#")[1]);
    const crafted = await relabelled({ env, row, id, slug: COIN(2), lane: 61 });
    const moved = { [`data/${COIN(1)}/a.json`]: `${crafted.name}#${id}` };
    const evil = await bundleOf({ env, slug: COIN(1), refs: moved, rows: [crafted] });
    const err = await readBundle({ blobs: env.fresh(), slug: COIN(1), kind: "holders", bundleRef: evil.bundleRef }).catch((e) => e);
    expect(err).toBeInstanceOf(BundleItemCoinError);
    expect(err.message).toContain(`${crafted.name}#${id}`);
    expect(err.message).toMatch(/example-02/);
    expect(err.message).toMatch(/bundle holders\/example-01|example-01/);
    expect(entry.bundle.ref).not.toBe(evil.bundleRef.ref);
    // The honest side: the same item under its own coin's label is read.
    const honest = await bundleOf({ env, slug: COIN(1), refs: { [`data/${COIN(1)}/a.json`]: bundle.blobs[`data/${COIN(1)}/a.json`] }, rows: [row], lane: 51 });
    await expect(readBundle({ blobs: env.fresh(), slug: COIN(1), kind: "holders", bundleRef: honest.bundleRef })).resolves.toBeTruthy();
  });

  it("refuses a bundle item that its pack labels with another coin", async () => {
    const env = track(makeEnv());
    const base = await bundleOf({ env, slug: COIN(1), refs: {}, rows: [] });
    const row = base.closed.packs[0];
    const crafted = await relabelled({ env, row, id: 0, slug: COIN(2), lane: 62 });
    const bundleRef = { ...base.bundleRef, ref: `${crafted.name}#0`, packSize: crafted.size, headerSha256: crafted.headerSha256 };
    const err = await readBundle({ blobs: env.fresh(), slug: COIN(1), kind: "holders", bundleRef }).catch((e) => e);
    expect(err).toBeInstanceOf(BundleItemCoinError);
    expect(err.message).toContain(`${crafted.name}#0`);
    expect(err.message).toMatch(/example-02/);
  });

  it("refuses an unlabelled item by default; only the explicit option accepts it (a pack written before this slice) and counts it", async () => {
    const env = track(makeEnv());
    const plain = createPackItemStore({ blobs: env.blobs, nameFor: nameFor(70) });
    const a = await plain.put(Buffer.from("old a"));
    const b = await plain.put(Buffer.from("old b"));
    const { packs } = await plain.close();
    const { bundleRef } = await bundleOf({ env, slug: COIN(1), refs: { "a.json": a, "b.json": b }, rows: packs });
    const seen = [];
    await expect(readBundle({ blobs: env.fresh(), slug: COIN(1), kind: "holders", bundleRef })).rejects.toThrow(/no coin label/); // strict by default
    await readBundle({ blobs: env.fresh(), slug: COIN(1), kind: "holders", bundleRef, allowUnlabelled: true, onItemsChecked: (r) => seen.push(r) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ itemsChecked: 3, unlabelled: 2 });
  });

  it("names an item that its pack header does not have", async () => {
    const env = track(makeEnv());
    const plain = createPackItemStore({ blobs: env.blobs, nameFor: nameFor(71) });
    const a = await plain.put(Buffer.from("only item"));
    const { packs } = await plain.close();
    const gone = `${packNameOf(a)}#7`;
    const { bundleRef } = await bundleOf({ env, slug: COIN(1), refs: { "a.json": gone }, rows: packs });
    const err = await readBundle({ blobs: env.fresh(), slug: COIN(1), kind: "holders", bundleRef }).catch((e) => e);
    expect(err).toBeInstanceOf(BundleVerifyError);
    expect(err.message).toContain(gone);
  });

  it("acceptChain refuses a chain entry with an item of another coin, with the coins in the detail", async () => {
    const env = track(makeEnv());
    const { bundle } = await writeCoin({ env, slug: COIN(1) });
    const path = `data/${COIN(1)}/a.json`;
    const row = bundle.packs.find((r) => r.name === packNameOf(bundle.blobs[path]));
    const id = Number(bundle.blobs[path].split("#")[1]);
    const crafted = await relabelled({ env, row, id, slug: COIN(2), lane: 63 });
    const evil = await bundleOf({ env, slug: COIN(1), refs: { [path]: `${crafted.name}#${id}` }, rows: [crafted], lane: 52 });
    const out = await acceptChain({ blobs: env.fresh(), slug: COIN(1), kind: "holders", main: null, chain: [evil.entry] });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("bundle not verified");
    expect(out.detail).toMatch(/example-02/);
  });
});
