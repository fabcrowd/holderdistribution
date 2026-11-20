// A lane writes random coins through the per-coin views with the coin boundary, and the
// pack table rows alone then answer every question the rest of the system asks: whose item is
// whose, what each header lists, which bundle names which items. Seeded: HD_STORE_SEEDS
// overrides the number of seeds (default 10; the release backend runs the first 2 of them).
import { afterAll, describe, expect, it } from "vitest";
import { createPackItemStore } from "./packItemStore.js";
import { createLane } from "./packLane.js";
import { openPack, PACK_COIN_LIMIT } from "./pack.js";
import { packName, KINDS } from "./packNames.js";
import { buildBundle, writeBundle, bundleRefOf, readBundle, bundleItems } from "./bundle.js";
import { packNameOf, refsIn } from "./itemRef.js";
import { nextUsage } from "./usage.js";
import { StoreUploadError } from "./blobStore.js";
import { folderEnv, releaseEnv, runOf } from "./recordKit.js";
import { rng } from "./storeTestKit.js";

const SEEDS = Number(process.env.HD_STORE_SEEDS ?? 10);
const CLASSES = ["keep", "hist", "live", "events"];
// Bundles get a store of their own (class live, the lane's own lane number, the class's shared flush
// counter): their references need the rows of the item packs, which exist only once those are uploaded.
const nameOf = (kind, run) => ({ cls, flush }) => packName({ cls, kind, day: DAY, run, attempt: 1, lane: 0, flush });
const storesOf = () => [...CLASSES.map((cls) => ({ name: cls, cls })), { name: "bundle", cls: "live" }];
const DAY = "2026-11-18";
const envs = [];
const track = (e) => { envs.push(e); return e; };
afterAll(() => envs.forEach((e) => e.cleanup()));
const COIN = (i) => `example-${String(i).padStart(2, "0")}`;
const noWrite = () => { throw new Error("read only"); };

function bytesOf(n, next) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
  return out;
}

// What one seed decides: how many coins, the limits, and per coin the items of each class.
function plan(seed) {
  const next = rng(seed);
  const pick = (n) => Math.floor(next() * n);
  const coins = 1 + pick(40);
  return {
    next, interleave: seed % 3 === 0, kind: KINDS[pick(2)], coins, coinLimit: [PACK_COIN_LIMIT, PACK_COIN_LIMIT, 4][pick(3)], targetBytes: 2000 + pick(30_000),
    items: Array.from({ length: coins }, () => CLASSES.map(() => Array.from({ length: pick(4) }, () => 1 + pick(6000)))),
  };
}

// Writes a coin's bundle as soon as every pack it names has a row, and ends the coin in the
// bundle store; the bundles and their puts are returned.
async function runLane({ env, p }) {
  const run = runOf(1000 + p.coins, 1);
  const lane = createLane({ blobs: env.blobs, nameFor: nameOf(p.kind, run.id), stores: storesOf(), coinLimit: p.coinLimit, targetBytes: p.targetBytes });
  const expected = []; // { ref, bytes, slug }
  const mine = new Map(); // slug -> [{ path, ref }]
  const waiting = [];
  const bundles = new Map(); // slug -> { bundle, put }
  let written = 0;
  let before = 0;

  async function writeReady(final) {
    const rowed = new Map(lane.rows().map((r) => [r.name, r]));
    for (const slug of [...waiting]) {
      const files = mine.get(slug);
      const named = new Set(files.map((f) => packNameOf(f.ref)));
      const ready = [...named].every((n) => rowed.has(n));
      if (!ready) continue;
      waiting.splice(waiting.indexOf(slug), 1);
      const bundle = buildBundle({
        slug, kind: p.kind, day: DAY, run, parent: null, usage: nextUsage({ parent: null, day: DAY, used: { providerA: 1 } }),
        blobs: Object.fromEntries(files.map((f) => [f.path, f.ref])), tables: {}, stateIndex: null,
        packs: [...named].sort().map((n) => rowed.get(n)),
      });
      bundles.set(slug, { bundle, put: await writeBundle(lane.store("bundle").forCoin(slug), bundle) });
      await lane.store("bundle").endCoin(slug);
      if (!final) before++;
    }
  }

  for (let c = 0; c < p.coins; c++) {
    const slug = COIN(c + 1);
    const views = lane.forCoin(slug);
    const files = [];
    for (const [k, sizes] of p.items[c].entries()) {
      for (const size of sizes) {
        const bytes = bytesOf(size, p.next);
        const path = `data/${slug}/${CLASSES[k]}-${written++}.bin`;
        const ref = await views[CLASSES[k]].put(bytes, { type: "blob", path });
        expected.push({ ref, bytes, slug });
        files.push({ path, ref });
      }
    }
    if (files.length === 0) {
      const bytes = bytesOf(10, p.next);
      const ref = await views.live.put(bytes, { type: "blob", path: `data/${slug}/only.bin` });
      expected.push({ ref, bytes, slug });
      files.push({ path: `data/${slug}/only.bin`, ref });
    }
    mine.set(slug, files);
    waiting.push(slug);
    // Seeds divisible by 3 never end a coin in the item stores: the limits are hard inside put (review P2).
    if (!p.interleave) await lane.endCoin(slug, CLASSES);
    for (const cls of CLASSES) expect(lane.store(cls).stats().openBytes).toBeLessThan(p.targetBytes);
    await writeReady(false);
  }
  await lane.closeStores(CLASSES);
  await writeReady(true);
  const { packs } = await lane.close();
  expect(waiting).toEqual([]);
  expect(lane.lostCoins()).toEqual([]);
  const names = packs.map((r) => r.name);
  expect(new Set(names).size, "pack names are unique across the lane's stores").toBe(names.length);
  return { lane, run, packs, expected, bundles, writtenBeforeEnd: before };
}

async function headerOf(blobs, row) {
  return (await openPack({ name: row.loc, size: row.size, readRange: (o, l) => blobs.readRange(row.loc, o, l) })).header;
}

async function check({ env, p, result }) {
  const { packs, expected, bundles, run } = result;
  const fresh = env.fresh();
  const reader = createPackItemStore({ blobs: fresh, nameFor: noWrite, packs });
  for (const { ref, bytes } of expected) expect((await reader.get(ref)).equals(bytes), `item ${ref}`).toBe(true);

  const bundleItemsByCoin = new Map();
  const labelsByRef = new Map(expected.map((e) => [e.ref, e.slug]));
  for (const row of packs) {
    const h = await headerOf(fresh, row);
    expect(h.items).toHaveLength(row.items);
    const coins = [...new Set(h.items.map((i) => i.slug))].sort();
    expect(h.slugs, `slugs of ${row.name}`).toEqual(coins);
    expect(coins.every((s) => typeof s === "string")).toBe(true);
    expect(coins.length, `coins in ${row.name}`).toBeLessThanOrEqual(p.coinLimit);
    for (const it of h.items) {
      if (it.type === "bundle") bundleItemsByCoin.set(it.slug, (bundleItemsByCoin.get(it.slug) ?? 0) + 1);
      else expect(labelsByRef.get(`${row.name}#${it.id}`), `label of ${row.name}#${it.id}`).toBe(it.slug);
    }
  }
  for (let c = 1; c <= p.coins; c++) expect(bundleItemsByCoin.get(COIN(c)), `bundles of ${COIN(c)}`).toBe(1);
  expect(bundleItemsByCoin.size).toBe(p.coins);

  const liveRows = result.lane.store("bundle").rows();
  for (const [slug, { bundle, put }] of bundles) {
    const bundleRef = bundleRefOf(put, liveRows);
    const seen = [];
    const got = await readBundle({ blobs: env.fresh(), slug, kind: p.kind, bundleRef, onItemsChecked: (r) => seen.push(r) });
    expect(got).toEqual(bundle);
    expect(seen).toHaveLength(1);
    expect(seen[0].unlabelled).toBe(0);
    const items = bundleItems({ blobs: env.fresh(), bundle: got, bundleRef });
    for (const ref of refsIn(Object.values(got.blobs))) {
      expect((await items.get(ref)).equals(expected.find((e) => e.ref === ref).bytes)).toBe(true);
    }
  }
  expect(run.attempt).toBe(1);
}

describe.each([["folder", folderEnv, SEEDS], ["release", releaseEnv, Math.min(2, SEEDS)]])("a lane on the %s backend, seeded", (_, makeEnv, seeds) => {
  it.each(Array.from({ length: seeds }, (_x, i) => [i + 1]))("seed %i", async (seed) => {
    const env = track(makeEnv());
    const p = plan(seed);
    const result = await runLane({ env, p });
    await check({ env, p, result });
    expect(result.packs.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("rows before the end", () => {
  it("a bundle written before the last flush resolves items in the packs the lane already uploaded", async () => {
    const env = track(folderEnv());
    const lane = createLane({ blobs: env.blobs, nameFor: nameOf("holders", 5), stores: storesOf(), coinLimit: 2 });
    const slugs = [COIN(1), COIN(2), COIN(3)];
    const refs = {};
    for (const slug of slugs) {
      refs[slug] = await lane.forCoin(slug).keep.put(Buffer.from(`keep ${slug}`), { type: "blob", path: `${slug}.json` });
      await lane.endCoin(slug);
    }
    const first = lane.rows();
    expect(first).toHaveLength(1); // coins 1 and 2 reached the limit; coin 3 is still open
    const bundle = buildBundle({
      slug: COIN(1), kind: "holders", day: DAY, run: runOf(5), parent: null, usage: nextUsage({ parent: null, day: DAY, used: {} }),
      blobs: { "a.json": refs[COIN(1)] }, tables: {}, stateIndex: null, packs: first,
    });
    const put = await writeBundle(lane.store("bundle").forCoin(COIN(1)), bundle);
    await lane.close();
    const bundleRef = bundleRefOf(put, lane.store("bundle").rows());
    const items = bundleItems({ blobs: env.fresh(), bundle: await readBundle({ blobs: env.fresh(), slug: COIN(1), kind: "holders", bundleRef }), bundleRef });
    expect((await items.get(refs[COIN(1)])).toString()).toBe("keep example-01");
    expect(packNameOf(refs[COIN(3)])).not.toBe(packNameOf(refs[COIN(1)]));
  });

  it("a failed upload exposes no row and the lane's error is named", async () => {
    const env = track(folderEnv());
    let calls = 0;
    const blobs = { ...env.blobs, upload: async (...a) => { if (++calls === 1) throw new StoreUploadError("injected: refused"); return env.blobs.upload(...a); } };
    const lane = createLane({ blobs, nameFor: nameOf("holders", 6), stores: storesOf().slice(0, CLASSES.length), coinLimit: 1 });
    await lane.forCoin(COIN(1)).keep.put(Buffer.from("x"), { type: "blob", path: "x" });
    await expect(lane.endCoin(COIN(1))).rejects.toThrow(StoreUploadError);
    await expect(lane.endCoin(COIN(1))).resolves.toBeTruthy(); // nothing is open any more: the pack is lost, not retried
    expect(lane.rows()).toEqual([]);
  });
});
