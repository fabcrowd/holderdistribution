// Test helpers for the record tests (bundle, manifest, candidate, chain, references): the
// two blob backends, and a writer that makes one coin's bundle through real packs the
// way a lane would: every item carries its coin and type, so the packs have the coin lists and
// the bundle items a lane's packs have. Not a test file itself. Neutral slugs only.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderBackend } from "./blobStoreFolder.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { createLane } from "./packLane.js";
import { packName } from "./packNames.js";
import { buildBundle, writeBundle, bundleRefOf } from "./bundle.js";
import { buildEntry } from "./manifest.js";
import { nextUsage } from "./usage.js";

export const SLUG = "example";
export const sha = (s) => createHash("sha256").update(s).digest("hex");
export const runOf = (id = 1, attempt = 1) => ({ id, attempt, workflow: "refresh-holders.yml" });

export function folderEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "records-"));
  return { name: "folder", dir, blobs: folderBackend(dir), fresh: () => folderBackend(dir), apiCalls: () => 0, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function releaseEnv() {
  const server = createFakeReleaseServer();
  const make = () => releaseBackend({
    owner: "o", repo: "r", token: "secret-token", http: server.http, now: () => server.clock.t,
    sleep: async (ms) => { server.clock.t += ms; },
  });
  return { name: "release", server, blobs: make(), fresh: make, cleanup() {} };
}

const nameFor = ({ kind, day, run, attempt, lane }) => ({ cls, flush }) => packName({ cls, kind, day, run, attempt, lane, flush });

const item = (label, n = 200) => Buffer.from(JSON.stringify({ label, pad: "x".repeat(n) }));

// Items go through two stores of one lane (both class live, one flush counter), as a lane's
// first flushes and its last pack would: the item store is closed first, so its packs have rows;
// the bundles then go into the bundle store together with one item each of their own pack, which
// a bundle names without a row. Several specs share the lane and so the packs (up to 16 coins
// share a pack): spec fields are those of writeCoin; kind, day and run of the first spec name
// the packs. Each call takes one lane number of its own, so two calls never write the same name.
export async function writeCoins({ env, specs }) {
  const { kind = "holders", day = "2026-11-18", run = runOf() } = specs[0];
  const laneNo = env.nextLane ?? 0;
  env.nextLane = laneNo + 1;
  const lane = createLane({
    blobs: env.blobs, nameFor: nameFor({ kind, day, run: run.id, attempt: run.attempt, lane: laneNo }),
    stores: [{ name: "items", cls: "live", targetBytes: 300 }, { name: "bundles", cls: "live", targetBytes: 1 << 20 }],
  });
  const bundleStore = (slug) => lane.forCoin(slug).bundles;
  const items = [];
  for (const { slug = SLUG } of specs) {
    const tag = `${slug} ${day} ${run.id}`;
    const mine = lane.forCoin(slug).items;
    items.push({
      a: await mine.put(item(`a ${tag}`), { type: "blob", path: `data/${slug}/a.json` }),
      base: await mine.put(item(`base ${tag}`), { type: "base", table: "acct", bucket: 0 }),
      index: await mine.put(item(`index ${tag}`), { type: "index" }),
    });
  }
  const { packs } = await lane.closeStores(["items"]);
  const owns = [];
  for (const { slug = SLUG } of specs) owns.push(await bundleStore(slug).put(item(`own ${slug} ${day} ${run.id}`), { type: "blob", path: `data/${slug}/own.json` }));
  const built = [];
  for (const [n, spec] of specs.entries()) {
    const { slug = SLUG, parent = null, parentUsage = null, used = { providerA: 10 } } = spec;
    const { a, base, index } = items[n];
    const mine = new Set([a, base, index].map((r) => r.slice(0, r.lastIndexOf("#"))));
    const bundle = buildBundle({
      slug, kind, day, run, parent,
      usage: nextUsage({ parent: parentUsage, day, used }),
      blobs: { [`data/${slug}/a.json`]: a, [`data/${slug}/own.json`]: owns[n] },
      tables: { acct: { L: 0, p: 0, buckets: [{ base, count: 3 }] } },
      stateIndex: index,
      packs: packs.filter((p) => mine.has(p.name)),
    });
    built.push({ slug, bundle, put: await writeBundle(bundleStore(slug), bundle), refs: { a, base, index, own: owns[n] } });
  }
  const closed = await lane.closeStores(["bundles"]);
  return built.map(({ slug, bundle, put, refs }) => {
    const bundleRef = bundleRefOf(put, closed.packs);
    return { bundle, bundleRef, entry: buildEntry({ slug, kind, bundleRef, bundle }), refs, rows: bundle.packs, ownRows: closed.packs };
  });
}

export async function writeCoin({ env, slug = SLUG, kind = "holders", day = "2026-11-18", run = runOf(), parent = null, parentUsage = null, used = { providerA: 10 } }) {
  return (await writeCoins({ env, specs: [{ slug, kind, day, run, parent, parentUsage, used }] }))[0];
}
