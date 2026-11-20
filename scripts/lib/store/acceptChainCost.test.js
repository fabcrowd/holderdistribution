// The label cross-check at the cost of what a night writes (review A3c, item 2): one header
// cache for a whole publish, a check by reference against the parent bundle, a version marker on
// the manifest entry that lets acceptChain trust the parent, and a strict rule for unlabelled items.
import { afterAll, describe, expect, it } from "vitest";
import { createPackItemStore } from "./packItemStore.js";
import { createHeaderCache } from "./packHeaderCache.js";
import { packName } from "./packNames.js";
import { buildBundle, bundleKey, bundleRefOf, readBundle, writeBundle } from "./bundle.js";
import { acceptChain } from "./acceptChain.js";
import { buildEntry, emptyManifest, LABEL_CHECK_VERSION, labelMarker, labelVouches, parseManifest, published, serializeManifest, validateEntry, withEntry } from "./manifest.js";
import { BundleItemCoinError, BundleItemUnlabelledError, RecordShapeError } from "./errors.js";
import { nextUsage } from "./usage.js";
import { folderEnv, releaseEnv, runOf, writeCoins } from "./recordKit.js";

const envs = [];
const track = (e) => { envs.push(e); return e; };
afterAll(() => envs.forEach((e) => e.cleanup()));
const S = "example-01";
const OTHER = "example-02";
const AT = "2026-11-18T03:12:40Z";
const D1 = "2026-11-17";
const D2 = "2026-11-18";
let lanes = 100;
let runs = 500;
const nameFor = (lane, day, run) => (flush) => packName({ cls: "live", kind: "holders", day, run, attempt: 1, lane, flush });
const paths = (refs, tag = "f") => Object.fromEntries(refs.map((r, i) => [`${tag}${i}.json`, r]));

// Items labelled `labels[i]` (a coin each; `plain` puts none), in one new pack: { refs, rows }.
async function itemsPack({ env, day, labels, plain = false }) {
  const lane = lanes++;
  const s = createPackItemStore({ blobs: env.blobs, nameFor: nameFor(lane, day, runs++), requireCoin: !plain });
  const refs = [];
  for (const [i, who] of labels.entries()) {
    const bytes = Buffer.from(`item ${lane} ${i}`);
    refs.push(plain ? await s.put(bytes) : await s.forCoin(who).put(bytes, { type: "blob" }));
  }
  return { refs, rows: (await s.close()).packs };
}

// The bundle and entry of coin S for `day`, naming `blobs` through `rows`, in a pack of its own.
async function makeEntry({ env, day, parent = null, blobs, rows, slug = S }) {
  const run = runOf(runs++);
  const s = createPackItemStore({ blobs: env.blobs, nameFor: nameFor(lanes++, day, run.id), requireCoin: true });
  const bundle = buildBundle({ slug, kind: "holders", day, run, parent, usage: nextUsage({ parent: null, day, used: { providerA: 1 } }), blobs, tables: {}, stateIndex: null, packs: rows });
  const put = await writeBundle(s.forCoin(slug), bundle);
  const bundleRef = bundleRefOf(put, (await s.close()).packs);
  return { bundle, bundleRef, entry: buildEntry({ slug, kind: "holders", bundleRef, bundle }) };
}

// Counts the range reads by pack location.
function counting(blobs) {
  const byLoc = new Map();
  return { blobs: { ...blobs, readRange: (loc, ...a) => { byLoc.set(loc, (byLoc.get(loc) ?? 0) + 1); return blobs.readRange(loc, ...a); } }, byLoc, total: () => [...byLoc.values()].reduce((x, y) => x + y, 0) };
}

const accept = (blobs, { main = null, chain, headers }) => acceptChain({ blobs, slug: S, kind: "holders", main, chain, ...(headers ? { headers } : {}) });

describe.each([["folder", folderEnv], ["release", releaseEnv]])("the label check at publish cost, %s backend", (_, makeEnv) => {
  it("an incremental check catches a new item under another coin's label, and accepts the honest chain", async () => {
    const env = track(makeEnv());
    const p1 = await itemsPack({ env, day: D1, labels: [S, S, S] });
    const e1 = await makeEntry({ env, day: D1, blobs: paths(p1.refs), rows: p1.rows });
    const evil = await itemsPack({ env, day: D2, labels: [OTHER] });
    const good = await itemsPack({ env, day: D2, labels: [S] });
    const bad2 = await makeEntry({ env, day: D2, parent: bundleKey(e1.bundleRef), blobs: { ...paths(p1.refs), "new.json": evil.refs[0] }, rows: [...p1.rows, ...evil.rows] });
    const ok2 = await makeEntry({ env, day: D2, parent: bundleKey(e1.bundleRef), blobs: { ...paths(p1.refs), "new.json": good.refs[0] }, rows: [...p1.rows, ...good.rows] });
    const out = await accept(env.fresh(), { chain: [e1.entry, bad2.entry] });
    expect(out).toMatchObject({ status: "refused", reason: "bundle not verified", index: 1 });
    expect(out.detail).toContain(evil.refs[0]);
    expect(out.detail).toMatch(/example-02/);
    const fine = await accept(env.fresh(), { chain: [e1.entry, ok2.entry] });
    expect(fine.status).toBe("accepted");
    expect(fine.entries.map((e) => e.labelCheck)).toEqual([e1.entry, ok2.entry].map((e) => labelMarker(e)));
  });

  it("a parent with no marker forces the full check; a current marker lets an item the parent names pass", async () => {
    const env = track(makeEnv());
    const bad = await itemsPack({ env, day: D1, labels: [OTHER] });
    const m = await makeEntry({ env, day: D1, blobs: { "bad.json": bad.refs[0] }, rows: bad.rows });
    const fresh = await itemsPack({ env, day: D2, labels: [S] });
    const c = await makeEntry({ env, day: D2, parent: bundleKey(m.bundleRef), blobs: { "bad.json": bad.refs[0], "new.json": fresh.refs[0] }, rows: [...bad.rows, ...fresh.rows] });
    const main = published(m.entry, AT);
    const out = await accept(env.fresh(), { main, chain: [c.entry] });
    expect(out).toMatchObject({ status: "refused", reason: "bundle not verified", index: 0 });
    expect(out.detail).toContain(bad.refs[0]);
    const trusted = await accept(env.fresh(), { main: { ...main, labelCheck: labelMarker(m.entry) }, chain: [c.entry] });
    expect(trusted.status).toBe("accepted");
  });

  it("a marker copied onto an entry with another bundle (built by spreading an old entry) is ignored and forces the full check", async () => {
    const env = track(makeEnv());
    const good = await itemsPack({ env, day: D1, labels: [S] });
    const old = await makeEntry({ env, day: D1, blobs: { "a.json": good.refs[0] }, rows: good.rows });
    const bad = await itemsPack({ env, day: D1, labels: [OTHER] });
    const m = await makeEntry({ env, day: D1, blobs: { "bad.json": bad.refs[0] }, rows: bad.rows });
    const fresh = await itemsPack({ env, day: D2, labels: [S] });
    const c = await makeEntry({ env, day: D2, parent: bundleKey(m.bundleRef), blobs: { "bad.json": bad.refs[0], "new.json": fresh.refs[0] }, rows: [...bad.rows, ...fresh.rows] });
    const forged = { ...published(m.entry, AT), labelCheck: labelMarker(old.entry) }; // names the old entry's bundle
    expect(labelVouches(forged)).toBe(false);
    expect(labelVouches({ ...published(m.entry, AT), labelCheck: labelMarker(m.entry) })).toBe(true);
    const out = await accept(env.fresh(), { main: forged, chain: [c.entry] });
    expect(out).toMatchObject({ status: "refused", reason: "bundle not verified", index: 0 });
    expect(out.detail).toContain(bad.refs[0]);
  });

  it("an item the parent bundle names is not read again; with no marker it is", async () => {
    const env = track(makeEnv());
    const a = await itemsPack({ env, day: D1, labels: [S, S] });
    const b = await itemsPack({ env, day: D1, labels: [S] });
    const d = await itemsPack({ env, day: D1, labels: [S] });
    const e1 = await makeEntry({ env, day: D1, blobs: { ...paths(a.refs, "a"), ...paths(b.refs, "b"), ...paths(d.refs, "d") }, rows: [...a.rows, ...b.rows, ...d.rows] });
    const n = await itemsPack({ env, day: D2, labels: [S] });
    const e2 = await makeEntry({ env, day: D2, parent: bundleKey(e1.bundleRef), blobs: { ...paths(a.refs, "a"), ...paths(b.refs, "b"), ...paths(d.refs, "d"), "n.json": n.refs[0] }, rows: [...a.rows, ...b.rows, ...d.rows, ...n.rows] });
    const carried = [...a.rows, ...b.rows, ...d.rows].map((r) => r.loc);

    const inChain = counting(env.fresh());
    const headers = createHeaderCache();
    expect((await accept(inChain.blobs, { chain: [e1.entry, e2.entry], headers })).status).toBe("accepted");
    // e1: its own header and item (2) and the 3 carried packs; e2: its own header and item (2) and the new pack (1).
    expect(inChain.total()).toBe(2 + 3 + 2 + 1);
    for (const loc of carried) expect(inChain.byLoc.get(loc), loc).toBe(1);
    expect(headers.stats().hits).toBe(0);

    const marked = counting(env.fresh());
    const main = { ...published(e1.entry, AT), labelCheck: labelMarker(e1.entry) };
    expect((await accept(marked.blobs, { main, chain: [e2.entry] })).status).toBe("accepted");
    for (const loc of carried) expect(marked.byLoc.get(loc) ?? 0, `${loc} must not be read`).toBe(0);
    expect(marked.total()).toBe(2 + 2 + 1); // the main bundle, e2's own header and item, the new pack

    const unmarked = counting(env.fresh());
    expect((await accept(unmarked.blobs, { main: published(e1.entry, AT), chain: [e2.entry] })).status).toBe("accepted");
    for (const loc of carried) expect(unmarked.byLoc.get(loc), loc).toBe(1);
  });

  it("an unlabelled item is refused in the publish path and by readBundle; only an explicit option counts it", async () => {
    const env = track(makeEnv());
    const plain = await itemsPack({ env, day: D2, labels: ["x", "y"], plain: true });
    const e = await makeEntry({ env, day: D2, blobs: paths(plain.refs), rows: plain.rows });
    const out = await accept(env.fresh(), { chain: [e.entry] });
    expect(out).toMatchObject({ status: "refused", reason: "bundle not verified" });
    expect(out.detail).toMatch(/no coin label/);
    await expect(readBundle({ blobs: env.fresh(), slug: S, kind: "holders", bundleRef: e.bundleRef })).rejects.toBeInstanceOf(BundleItemUnlabelledError);
    const seen = [];
    await readBundle({ blobs: env.fresh(), slug: S, kind: "holders", bundleRef: e.bundleRef, allowUnlabelled: true, onItemsChecked: (r) => seen.push(r) });
    expect(seen[0]).toMatchObject({ itemsChecked: 3, unlabelled: 2 });
    // acceptChain does not take the option: passing it changes nothing.
    expect((await acceptChain({ blobs: env.fresh(), slug: S, kind: "holders", main: null, chain: [e.entry], allowUnlabelled: true })).status).toBe("refused");
  });

  it("another coin's label is still BundleItemCoinError under readBundle with the explicit option", async () => {
    const env = track(makeEnv());
    const evil = await itemsPack({ env, day: D2, labels: [OTHER] });
    const e = await makeEntry({ env, day: D2, blobs: { "x.json": evil.refs[0] }, rows: evil.rows });
    await expect(readBundle({ blobs: env.fresh(), slug: S, kind: "holders", bundleRef: e.bundleRef, allowUnlabelled: true })).rejects.toBeInstanceOf(BundleItemCoinError);
  });

  it("pinned: three coins sharing packs cost one header read per distinct pack plus one bundle read each; separate caches cost the sum", async () => {
    const env = track(makeEnv());
    const slugs = ["example-01", "example-02", "example-03"];
    const built = await writeCoins({ env, specs: slugs.map((slug) => ({ slug })) });
    const named = built.map((b) => new Set([b.bundleRef.ref.slice(0, b.bundleRef.ref.lastIndexOf("#")), ...b.bundle.packs.map((r) => r.name)]));
    const distinct = new Set(named.flatMap((s) => [...s]));
    const run = async (shared) => {
      const c = counting(env.fresh());
      const headers = createHeaderCache();
      for (const [i, b] of built.entries()) {
        const out = await acceptChain({ blobs: c.blobs, slug: slugs[i], kind: "holders", main: null, chain: [b.entry], ...(shared ? { headers } : {}) });
        expect(out.status).toBe("accepted");
      }
      return c.total();
    };
    const together = await run(true);
    const apart = await run(false);
    expect(together).toBe(distinct.size + 3);
    expect(apart).toBe(named.reduce((n, s) => n + s.size, 0) + 3);
    expect(together).toBeLessThan(apart);
  });
});

describe("the manifest entry's check marker (labelCheck)", () => {
  it("is an optional { version, bundle } on an entry, refused on a candidate by acceptChain, and survives a round trip", async () => {
    const env = track(folderEnv());
    const p = await itemsPack({ env, day: D2, labels: [S] });
    const { entry } = await makeEntry({ env, day: D2, blobs: { "a.json": p.refs[0] }, rows: p.rows });
    const pub = published(entry, AT);
    const ctx = { slug: S, kind: "holders" };
    expect(() => validateEntry(pub, ctx)).not.toThrow();
    const marker = labelMarker(entry);
    expect(marker).toEqual({ version: LABEL_CHECK_VERSION, bundle: bundleKey(entry.bundle) });
    expect(() => validateEntry({ ...pub, labelCheck: marker }, ctx)).not.toThrow();
    const bads = [LABEL_CHECK_VERSION, "1", 0, null, { version: 1 }, { bundle: marker.bundle }, { ...marker, version: 0 }, { ...marker, bundle: "" }, { ...marker, extra: 1 }];
    for (const bad of bads) expect(() => validateEntry({ ...pub, labelCheck: bad }, ctx)).toThrow(RecordShapeError);
    // a lane cannot vouch for itself: acceptChain refuses a candidate that carries the marker
    await expect(acceptChain({ blobs: env.fresh(), slug: S, kind: "holders", main: null, chain: [{ ...entry, labelCheck: marker }] })).rejects.toBeInstanceOf(RecordShapeError);
    const m = withEntry(emptyManifest(S), "holders", { ...pub, labelCheck: marker });
    expect(parseManifest(serializeManifest(m), { slug: S }).entries.holders.labelCheck).toEqual(marker);
  });
});
