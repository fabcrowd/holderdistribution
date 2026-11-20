// Test support for the adoption tests (adoption.test.js, adoptionCost.test.js,
// adoptionProperty.test.js). Not a test file itself. Neutral slugs only.
//
// A world is a blob store with packs written the way a lane writes them, but with the header
// facts adoption reads (`slugs`, and per item `type` and `slug`): packItemStore.put takes no
// item info today, so the kit writes packs with createPackWriter directly. Each coin of a
// pack gets a blob, a table base and its bundle; a coin with a `parent` carries the parent's
// base by reference (and the parent pack's row), as a lane carries an unchanged base, so a
// damaged parent pack breaks the child too.
//
// `listRelease(tag)` here is the series listing filtered to one release, with the states a test
// sets (starter, dead) applied and the requests modelled as pages of 100 assets; the store's own
// blobs.listRelease has no way to hold a state a test invents. A lane with none injected uses the store's.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBundle, bundleKey, serializeBundle } from "./bundle.js";
import { folderBackend } from "./blobStoreFolder.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { buildEntry, published } from "./manifest.js";
import { createPackWriter, packToBuffer } from "./pack.js";
import { packName } from "./packNames.js";
import { nextUsage } from "./usage.js";

export const AT = "2026-11-18T03:12:40Z";
// The lane clock of every world: nine days after the main day the tests use (2026-11-10).
export const NOW = "2026-11-19T06:00:00Z";
export const PAGE = 100;
export const runOf = (id, attempt = 1) => ({ id, attempt, workflow: "refresh-holders.yml" });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const filler = (label, bulk) => Buffer.concat([Buffer.from(JSON.stringify({ label })), Buffer.alloc(bulk, 7)]);

export const dayPlus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function bundleOf({ c, kind, day, run, attempt, refs }) {
  // `c.tamperRow` changes the carried pack row, to model a writer that recorded a wrong one.
  const slug = c.as ?? c.slug;
  const parent = c.parent ?? null;
  const carry = parent && c.carry !== false;
  return buildBundle({
    slug, kind, day, run: runOf(run, attempt), parent: parent ? parent.key : null,
    usage: nextUsage({ parent: parent?.entry.usage ?? null, day, used: { providerA: 10 } }),
    blobs: { [`data/${slug}/a.json`]: refs.a },
    tables: { acct: { L: 0, p: 0, buckets: [{ base: refs.base, prev: carry ? parent.refs.base : null }] } },
    stateIndex: null,
    packs: carry ? [c.tamperRow ? c.tamperRow(parent.pack) : parent.pack] : [],
  });
}

export function createWorld({ backend = "folder" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adoption-"));
  const server = backend === "release" ? createFakeReleaseServer() : null;
  const blobs = server
    ? releaseBackend({ owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t, sleep: async (ms) => { server.clock.t += ms; } })
    : folderBackend(dir);
  const states = new Map();
  const world = { dir, blobs, calls: { listRelease: 0, existingReleases: 0 }, packs: [] };

  async function place(name, release, buf) {
    if (server) return (await blobs.upload(name, buf)).loc;
    fs.mkdirSync(path.join(dir, release), { recursive: true });
    fs.writeFileSync(path.join(dir, release, name), buf);
    return `${release}/${name}`;
  }

  // One pack. coins: [{ slug, parent?, as?, carry?, itemSlug? }]; `parent` is a record this function
  // returned; `as` writes the bundle of another coin under this coin's item label; `itemSlug` is
  // the coin label of the coin's blob item (another coin's, or null for an unlabelled item).
  world.writePack = async ({ kind = "holders", day, bundleDay = day, run, attempt = 1, lane = 0, flush = 0, release = "data-live-1", coins, bulk = 0, salt = "", state = "uploaded", createdAt = `${day}T04:00:00Z` }) => {
    const name = packName({ cls: "live", kind, day, run, attempt, lane, flush });
    const writer = createPackWriter({ meta: { class: "live", kind, day, run, attempt, lane, flush } });
    const staged = [];
    for (const c of coins) {
      const tag = `${c.slug} ${day} ${run}a${attempt} ${salt}`;
      const a = await writer.add(filler(`a ${tag}`, bulk), { slug: c.itemSlug === undefined ? c.slug : c.itemSlug, type: "blob", path: `data/${c.slug}/a.json`, enc: "raw" });
      const base = await writer.add(filler(`base ${tag}`, bulk), { slug: c.slug, type: "base", table: "acct", bucket: 0, enc: "raw" });
      const refs = { a: `${name}#${a.id}`, base: `${name}#${base.id}` };
      const bundle = bundleOf({ c, kind, day: bundleDay, run, attempt, refs });
      const bytes = serializeBundle(bundle);
      const item = await writer.add(bytes, { slug: c.slug, type: "bundle", enc: "raw" });
      staged.push({ c, refs, bundle, bytes, items: { a, base, bundle: item } });
    }
    const out = await writer.finish();
    const buf = await packToBuffer(out);
    await out.dispose();
    const loc = await place(name, release, buf);
    if (!server) fs.utimesSync(path.join(dir, loc), new Date(createdAt), new Date(createdAt)); // the listing's creation time
    const tagOf = loc.slice(0, loc.indexOf("/"));
    if (state !== "uploaded") states.set(loc, state);
    const row = { name, loc, size: buf.length, sha256: sha(buf), headerSha256: sha(buf.subarray(0, out.bodyStart)), items: writer.count };
    const pack = { name, loc, release: tagOf, kind, day, createdAt, size: buf.length, bodyStart: out.bodyStart, row, coins: {} };
    for (const s of staged) {
      const bundleRef = { ref: `${name}#${s.items.bundle.id}`, release: tagOf, packSize: buf.length, headerSha256: row.headerSha256, sha256: sha(s.bytes) };
      const entry = buildEntry({ slug: s.c.slug, kind, bundleRef, bundle: s.bundle });
      pack.coins[s.c.slug] = { slug: s.c.slug, kind, key: bundleKey(bundleRef), entry, bundleRef, bundle: s.bundle, refs: s.refs, items: s.items, pack: row, packInfo: pack };
    }
    world.packs.push(pack);
    return pack;
  };

  world.one = async (spec) => (await world.writePack({ ...spec, coins: [{ slug: spec.slug, parent: spec.parent, as: spec.as, carry: spec.carry, tamperRow: spec.tamperRow, itemSlug: spec.itemSlug }] })).coins[spec.slug];

  const fileOf = (loc) => path.join(dir, loc);
  // Damage after the upload: "truncate" and "magic" break the pack; "bundle", "base" and
  // "blob" flip a byte inside that coin's own item, so only that coin is affected.
  // The creation time (the file's mtime) is kept: damage is not an upload.
  world.damage = (target, how) => {
    const isCoin = Boolean(target.packInfo);
    const info = isCoin ? target.packInfo : target;
    const file = fileOf(info.loc);
    const before = fs.statSync(file);
    damageFile({ file, how, isCoin, target, info });
    fs.utimesSync(file, before.atime, before.mtime);
  };

  function damageFile({ file, how, isCoin, target, info }) {
    const buf = fs.readFileSync(file);
    if (how === "truncate") fs.writeFileSync(file, buf.subarray(0, buf.length - 5));
    else if (how === "append") fs.writeFileSync(file, Buffer.concat([buf, Buffer.alloc(5)]));
    else if (how === "magic") fs.writeFileSync(file, Buffer.concat([Buffer.from("XXXX"), buf.subarray(4)]));
    else {
      if (!isCoin) throw new Error(`damage "${how}" needs a coin record`);
      const it = target.items[how === "blob" ? "a" : how];
      buf[info.bodyStart + it.off + (it.len >> 1)] ^= 0xff;
      fs.writeFileSync(file, buf);
    }
  }

  world.remove = (pack) => fs.rmSync(fileOf(pack.loc));

  world.setState = (pack, state) => states.set(pack.loc, state);

  world.listRelease = async (tag) => {
    world.calls.listRelease++;
    const entries = (await blobs.list("live")).filter((e) => e.release === tag).map((e) => (states.has(e.loc) ? { ...e, state: states.get(e.loc) } : e));
    return { entries, requests: Math.max(1, Math.ceil(entries.length / PAGE)) };
  };

  // The tags of the releases that exist in a series (one request); the store's listReleaseTags answers the same.
  world.existingReleases = async (series) => {
    world.calls.existingReleases++;
    const all = server ? server.releases.map((r) => r.tag_name) : fs.readdirSync(dir);
    return { tags: all.filter((t) => t.startsWith(`data-${series}-`)).sort(), requests: 1 };
  };

  world.now = () => Date.parse(NOW);
  // The lane's injected sleep: it takes no time and records the waits it was asked for.
  world.sleeps = [];
  world.sleep = async (ms) => { world.sleeps.push(ms); };
  world.listing = { listRelease: world.listRelease, existingReleases: world.existingReleases, now: world.now, sleep: world.sleep };

  world.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return world;
}

// A published main entry for a coin record (the entry the manifest on main would name).
export const publishedOf = (rec) => published(rec.entry, AT);

// Wraps a blob store and logs every range read and stat, so a test can check what was read.
export function spyBlobs(blobs) {
  const log = [];
  return {
    log,
    blobs: {
      ...blobs,
      async stat(loc) { log.push({ op: "stat", loc }); return blobs.stat(loc); },
      async readRange(loc, off, len) { log.push({ op: "range", loc, off, len }); return blobs.readRange(loc, off, len); },
    },
  };
}
