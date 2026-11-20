// The lane's start step (design 2.1 section 9.1, start steps 1 to 5), with every effect injected:
//   blobs        the blob store (blobStore.js interface)
//   git          reads of origin/main through a seam (the only place git is named; gitReadGuard.test.js
//                limits where git may run, so a real seam is made by the workflow step or the CLI):
//                  readManifest(slug) -> text | null      data/manifests/<slug>.json (null: main has none for the coin)
//                  readStoreFile() -> text                data/manifests/store.json
//                  firstParentHistory() -> { commits, complete }   the stale-code guard's input
//                  isAncestor(sha) -> boolean | Promise<boolean>
//                A seam that cannot answer throws OriginFactsError (laneCli.js fileGit does for a missing
//                file): for the coin's own fact the coin fails (stage "origin"), for the lane's the lane stops.
//   now          the clock, milliseconds (adoption's)
//   attemptStart when this run attempt started (the guard's `t`)
//   outDir       the directory the coin's files are restored into (paths are repo-relative)
//   startDir     where start.json goes (<startDir>/<slug>/start.json, startRecord.js)
//   specsFor     (slug) -> the coin's table specs (laneTables.js: { table, path, fields, rowsPerBucket, format });
//                a spec with `retired: true` is kept only so restore can still write the file of a table
//                the start bundle holds; the end step stores that file as a blob (lanePack.js)
//   layoutFor    (slug) -> the coin's layout (storeFiles.js coinLayout)
// Per coin: manifest and store.json from origin/main, the stale-code guard (a refusal stops the coin
// with StaleCodeError, the others of the lane too: the code, not the coin, is old), adoption (adoptLane,
// one listing per lane), then the start bundle is restored: blobs by reference, tables bucket by bucket
// through the format, each rebuilt bucket checked by the state check (tableRead.rowsAt against the
// index, then against the bundle's own descriptor), and start.json written. A coin that fails is
// reported and skipped; the lane goes on. Before a start is written, the coin's stored files of the kind
// are removed from outDir (a file the generator deleted must not come back from a checkout); each rebuilt
// table file must hash to the sha256 recorded when it was packed (the state index, laneState.js).
//
// Memory: a blob is one item in memory (at most 16 MiB; a sliced blob is written slice by slice, 8 MiB);
// a table is one bucket at a time (at most about 2R rows, design 3.1), whatever the table's size.
// Requests: reads by range only, no core request; the lane's one adoption listing (18 requests for the
// usual night, adoptionLane.js). Cost per coin: the bases and change rows of the start state, up to
// 228·H bytes at H holders (design 14.4); nothing grows with D.
import fs from "node:fs/promises";
import path from "node:path";
import { adoptLane } from "./adoptionLane.js";
import { parseManifest, entryFor } from "./manifest.js";
import { parseStoreFile } from "./pointerFiles.js";
import { assertCodeCurrent, StaleCodeError } from "./staleCodeGuard.js";
import { START_FILE, buildStartRecord, writeStartRecord } from "./startRecord.js";
import { checkState, hashToHex } from "./stateCheck.js";
import { bucketsAt, createReader, rowsAt } from "./tableRead.js";
import { currentPosition } from "./tableIndex.js";
import { openStart } from "./laneState.js";
import { RecordError } from "./errors.js";
import { DuplicateCoinError, OriginFactsError, RestoreError, failedRow, isProgrammingError, parseSliceKey } from "./laneNames.js";
import { hashFile } from "./laneBlobs.js";
import { listCoinFiles } from "../storeFiles.js";

// A path from a bundle is data: it must stay inside outDir.
export function safeJoin(outDir, rel, slug) {
  const abs = path.resolve(outDir, rel);
  const inside = path.relative(path.resolve(outDir), abs);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside) || rel.includes("\0")) throw new RestoreError(slug, "start", `path ${JSON.stringify(rel)} leaves the output directory`);
  return abs;
}

async function writeAtomic(abs, write) {
  const tmp = `${abs}.restore-${process.pid}`;
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await write(tmp);
    await fs.rename(tmp, abs);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// Whole blobs by key, sliced blobs gathered by path.
function splitBlobs(blobs, slug) {
  const whole = [];
  const sliced = new Map();
  for (const [key, ref] of Object.entries(blobs)) {
    const s = parseSliceKey(key);
    if (!s) whole.push([key, ref]);
    else sliced.set(s.path, [...(sliced.get(s.path) ?? []), { n: s.n, ref }]);
  }
  for (const [p, list] of sliced) {
    list.sort((a, b) => a.n - b.n);
    if (list.some((x, i) => x.n !== i)) throw new RestoreError(slug, "start", `blob ${p} has slices ${list.map((x) => x.n).join(",")}, not 0 to ${list.length - 1}`);
  }
  return { whole, sliced };
}

async function restoreBlobs({ start, slug, outDir, skip }) {
  const { whole, sliced } = splitBlobs(start.bundle.blobs, slug);
  const written = [];
  for (const [rel, ref] of whole) {
    if (skip.has(rel)) continue;
    const bytes = await start.items.get(ref);
    await writeAtomic(safeJoin(outDir, rel, slug), (tmp) => fs.writeFile(tmp, bytes));
    written.push(rel);
  }
  for (const [rel, list] of sliced) {
    await writeAtomic(safeJoin(outDir, rel, slug), async (tmp) => {
      const fh = await fs.open(tmp, "w");
      try {
        for (const { ref } of list) await fh.write(await start.items.get(ref));
      } finally {
        await fh.close();
      }
    });
    written.push(rel);
  }
  return written;
}

function checkDescriptor(desc, idx, name, slug) {
  const same = desc.L === idx.layout.L && desc.p === idx.layout.p && desc.buckets.length === idx.buckets.length
    && desc.buckets.every((b, j) => b.base === (idx.buckets[j].base?.ref ?? null));
  if (!same) throw new RestoreError(slug, "start", `table ${name}: the bundle's descriptor and the state index disagree on the layout or the bases`);
}

async function restoreTable({ start, slug, outDir, spec, desc }) {
  const idx = start.index?.tables[spec.table];
  if (!idx) throw new RestoreError(slug, "start", `table ${spec.table} is in the bundle but not in its state index`);
  const packed = start.index.files[spec.table];
  if (typeof packed?.sha256 !== "string") throw new RestoreError(slug, "start", `table ${spec.table} has no file hash in the state index`);
  checkDescriptor(desc, idx, spec.table, slug);
  const P = currentPosition(idx);
  const reader = createReader(start.items, idx);
  const records = [];
  async function* buckets() {
    for (const j of bucketsAt(idx, P).buckets) {
      const r = await rowsAt(start.items, idx, P, j, reader);
      checkState({ table: spec.table, bucket: j, day: P.day, part: "end" }, r, desc.buckets[j], "bundle descriptor");
      records.push({ bucket: j, count: r.count, hash: hashToHex(r.hash) });
      yield { bucket: j, rows: r.rows };
    }
  }
  await writeAtomic(safeJoin(outDir, spec.path, slug), async (tmp) => {
    await spec.format.write(tmp, desc.header, buckets());
    const got = await hashFile(tmp);
    if (got !== packed.sha256) throw new RestoreError(slug, "start", `table ${spec.table}: the rebuilt ${spec.path} has sha256 ${got}, the file that was packed had ${packed.sha256}; the table format's write is not byte-stable`);
  });
  return records;
}

// The files of the kind that the generator may have deleted since the start state was packed must not
// come back: they are removed first (hand-kept and scratch files, which are never stored, stay). Safe when
// outDir is the checkout, whose tracked copies of generated files would otherwise survive.
async function clearKindFiles({ outDir, layout, kind, slug }) {
  const { files } = await listCoinFiles({ root: outDir, layout, kind });
  for (const rel of files) await fs.rm(safeJoin(outDir, rel, slug), { force: true });
}

// Restores one start into outDir: { files, buckets } (buckets in start.json's shape).
export async function restoreStart({ start, slug, kind, layout, outDir, specs }) {
  const bySpec = new Map(specs.map((s) => [s.table, s]));
  const held = Object.keys(start.bundle.tables);
  for (const t of held) if (!bySpec.has(t)) throw new RestoreError(slug, "start", `the bundle has table ${t}, which no table spec names; keep its spec with retired: true until a night has stored its file as a blob`);
  await clearKindFiles({ outDir, layout, kind, slug });
  const files = await restoreBlobs({ start, slug, outDir, skip: new Set(held.map((t) => bySpec.get(t).path)) });
  const buckets = {};
  for (const table of held) {
    buckets[table] = await restoreTable({ start, slug, outDir, spec: bySpec.get(table), desc: start.bundle.tables[table] });
    files.push(bySpec.get(table).path);
  }
  return { files: files.sort(), buckets };
}

async function readMain(git, slug, kind) {
  const text = await git.readManifest(slug);
  return text === null ? null : entryFor(parseManifest(text, { slug }), kind);
}

async function liveTagOf(git) {
  const text = await git.readStoreFile();
  return text === null ? null : (parseStoreFile(text).releases.live ?? null);
}

async function staleOf(git, attemptStart) {
  const { commits, complete } = await git.firstParentHistory();
  try {
    await assertCodeCurrent({ attemptStart, complete, commits, isAncestor: (sha) => git.isAncestor(sha) });
    return null;
  } catch (err) {
    if (err instanceof StaleCodeError) return err;
    throw err;
  }
}

async function mainsOf(git, slugs, kind, stale) {
  const mains = new Map();
  const failed = new Map();
  for (const slug of slugs) {
    if (stale) {
      failed.set(slug, failedRow(slug, new RestoreError(slug, "stale-code", `${stale.message}`)));
      continue;
    }
    try {
      mains.set(slug, await readMain(git, slug, kind));
    } catch (err) {
      if (err instanceof OriginFactsError) failed.set(slug, failedRow(slug, err, "origin"));
      else if (err instanceof RecordError) failed.set(slug, failedRow(slug, new RestoreError(slug, "manifest", `cannot read the manifest: ${err.message}`)));
      else throw err;
    }
  }
  return { mains, failed };
}

async function restoreOne({ slug, kind, adopted, main, blobs, outDir, startDir, specs, layout }) {
  // First, so a restore that fails never leaves an earlier run's start.json beside half-cleared files.
  await fs.rm(path.join(startDir, slug, START_FILE), { force: true });
  const start = adopted.start ? await openStart({ blobs, slug, kind, entry: adopted.start.entry, bundle: adopted.start.bundle }) : null;
  const restored = start ? await restoreStart({ start, slug, kind, layout, outDir, specs }) : { files: [], buckets: {} };
  const record = buildStartRecord({ slug, kind, main, chain: adopted.chain, buckets: restored.buckets });
  await writeStartRecord(startDir, record);
  return { status: "restored", slug, source: adopted.start?.source ?? "new", chain: adopted.chain.length, files: restored.files, buckets: restored.buckets, alerts: adopted.alerts };
}

export async function restoreLane({ kind, slugs, blobs, git, now, attemptStart, outDir, startDir, specsFor, layoutFor, sleep, reserve }) {
  const twice = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (twice) throw new DuplicateCoinError(twice);
  const stale = await staleOf(git, attemptStart);
  const { mains, failed } = await mainsOf(git, slugs, kind, stale);
  const active = [...mains.keys()];
  const liveTag = await liveTagOf(git);
  const adoption = liveTag && active.length > 0
    ? await adoptLane({ blobs, liveTag, kind, now, sleep, reserve, coins: active.map((slug) => ({ slug, main: mains.get(slug) })) })
    : null;
  const coins = Object.fromEntries(failed);
  for (const slug of active) {
    const main = mains.get(slug);
    const adopted = adoption ? adoption.coins[slug] : { failed: false, chain: [], start: main ? { source: "main", entry: main, bundle: null } : null, alerts: [] };
    if (adopted.failed) {
      coins[slug] = failedRow(slug, new RestoreError(slug, "adoption", `adoption failed: ${adopted.error?.message ?? adopted.error}`));
      continue;
    }
    try {
      coins[slug] = await restoreOne({ slug, kind, adopted, main, blobs, outDir, startDir, specs: specsFor(slug), layout: layoutFor(slug) });
    } catch (err) {
      if (isProgrammingError(err)) throw err;
      coins[slug] = failedRow(slug, err, "start");
    }
  }
  return { coins: Object.fromEntries(slugs.map((s) => [s, coins[s]])), adoption: adoption ? { listing: adoption.listing, reads: adoption.reads } : null };
}
