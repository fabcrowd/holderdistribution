// Test helpers for the record tests (bundle, manifest, candidate, chain, references): the
// two blob backends, and a writer that makes one coin's bundle through real packs the
// way a lane would. Not a test file itself. Neutral slugs only.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderBackend } from "./blobStoreFolder.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { createPackItemStore } from "./packItemStore.js";
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

const nameFor = ({ kind, day, run, attempt, lane }) => (flush) => packName({ cls: "live", kind, day, run, attempt, lane, flush });

const item = (label, n = 200) => Buffer.from(JSON.stringify({ label, pad: "x".repeat(n) }));

// Items go through two stores, as a lane's first flushes and its last pack would: store one
// is closed first, so its packs have rows; the bundles then go into store two together with
// one item each of their own pack, which a bundle names without a row. Several specs share
// the lanes and so the packs (up to 16 coins share a pack): spec fields are those of
// writeCoin; kind, day and run of the first spec name the packs.
export async function writeCoins({ env, specs }) {
  const { kind = "holders", day = "2026-11-18", run = runOf() } = specs[0];
  // Each call takes two lanes of its own, so two calls never write the same pack name.
  const first = env.nextLane ?? 0;
  env.nextLane = first + 2;
  const lane0 = createPackItemStore({ blobs: env.blobs, nameFor: nameFor({ kind, day, run: run.id, attempt: run.attempt, lane: first }), targetBytes: 300 });
  const lane1 = createPackItemStore({ blobs: env.blobs, nameFor: nameFor({ kind, day, run: run.id, attempt: run.attempt, lane: first + 1 }), targetBytes: 1 << 20 });
  const items = [];
  for (const { slug = SLUG } of specs) {
    const tag = `${slug} ${day} ${run.id}`;
    items.push({ a: await lane0.put(item(`a ${tag}`)), base: await lane0.put(item(`base ${tag}`)), index: await lane0.put(item(`index ${tag}`)) });
  }
  const { packs } = await lane0.close();
  const owns = [];
  for (const { slug = SLUG } of specs) owns.push(await lane1.put(item(`own ${slug} ${day} ${run.id}`)));
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
    built.push({ slug, bundle, put: await writeBundle(lane1, bundle), refs: { a, base, index, own: owns[n] } });
  }
  const closed = await lane1.close();
  return built.map(({ slug, bundle, put, refs }) => {
    const bundleRef = bundleRefOf(put, closed.packs);
    return { bundle, bundleRef, entry: buildEntry({ slug, kind, bundleRef, bundle }), refs, rows: bundle.packs, ownRows: closed.packs };
  });
}

export async function writeCoin({ env, slug = SLUG, kind = "holders", day = "2026-11-18", run = runOf(), parent = null, parentUsage = null, used = { providerA: 10 } }) {
  return (await writeCoins({ env, specs: [{ slug, kind, day, run, parent, parentUsage, used }] }))[0];
}
