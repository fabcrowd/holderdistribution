// The lane's end step (design 2.1 section 9.1, end steps 1 to 6), with every effect injected (the same
// seams as laneRestore.js; `git` here needs readManifest only):
//   packCoin(slug): read start.json, list the kind's files (storeFiles.js; an unclassified file fails
//     the coin), settle the blobs (laneBlobs.js), write each table's change file, due bases and due
//     splits (laneTables.js), through the lane's open packs (packLane.js createLane: `forCoin`, `endCoin`).
//   a group of coins (at most `groupSize`, 16 as a pack's coin limit) is closed together: the item
//     and change-file packs upload, then each coin's state index item and bundle are written (the bundle
//     names rows of uploaded packs, bundle.js), the bundles' pack uploads, and the candidate record of the
//     group is written to `candidateDir` as `candidate-<kind>-l<lane>f<group>-a<attempt>.json`.
// A coin that fails is reported and skipped; the lane goes on. A coin whose pack failed to upload fails
// with the others of that pack, at the group's close.
// Classes: bases and blobs and the index and the bundle are `live`; the change files are `hist`.
// Left out of this slice (named in the report): the yearly copy (section 6), list versions, history
// files and the day store (end step 4); the candidate is written to disk, not uploaded as an artifact.
//
// Cost by size per coin: the stored files read once, the table file read once (twice on a first
// write); writes: changed blobs, the change file (50·C), due bases (design 14.2); no listing and no
// core request besides the uploads the lane makes (2 requests per pack, 4 packs per 16 coins at most);
// per lane of c coins: ceil(c / 16) groups, so 3 packs a group (live items, hist, live bundles).
// Memory: laneTables.js and laneBlobs.js (one bucket, one 16 MiB blob); the lane keeps one state
// index per coin of the open group (about 90 KB each, design 3.2) until the group closes.
import fs from "node:fs/promises";
import path from "node:path";
import { buildBundle, bundleRefOf, writeBundle } from "./bundle.js";
import { buildCandidate, serializeCandidate } from "./candidate.js";
import { entryFor, entryKey, buildEntry, parseManifest } from "./manifest.js";
import { createLane } from "./packLane.js";
import { PACK_COIN_LIMIT } from "./pack.js";
import { packName } from "./packNames.js";
import { readStartRecord } from "./startRecord.js";
import { checkState } from "./stateCheck.js";
import { nextUsage } from "./usage.js";
import { listCoinFiles } from "../storeFiles.js";
import { packBlobs, hashFile } from "./laneBlobs.js";
import { createTableStore } from "./laneItems.js";
import { DuplicateCoinError, PackStepError, dayNumber, failedRow, isProgrammingError } from "./laneNames.js";
import { knownRows, openStart, packNamesIn, serializeStateIndex } from "./laneState.js";
import { packTable, tableDescriptor } from "./laneTables.js";

const CARRY_MARGIN_DAYS = 30;
const DEFAULT_HISTORY_DAYS = 400;

async function startOf({ blobs, git, slug, kind, rec }) {
  let entry = rec.chain.at(-1) ?? null;
  if (!entry && rec.parent !== null) {
    const text = await git.readManifest(slug);
    const main = text === null ? null : entryFor(parseManifest(text, { slug }), kind);
    if (!main || entryKey(main) !== rec.parent) throw new PackStepError(slug, "pack", "the manifest on main no longer names the bundle this lane started from");
    entry = main;
  }
  return { entry, start: await openStart({ blobs, slug, kind, entry }) };
}

// start.json's bucket records are what the restore checked; the bundle must still say the same.
function checkStartRecord({ slug, rec, start }) {
  for (const [table, desc] of Object.entries(start?.bundle.tables ?? {})) {
    const rows = rec.buckets[table] ?? [];
    if (rows.length !== desc.buckets.length) throw new PackStepError(slug, "pack", `start.json holds ${rows.length} buckets of table ${table}, the start bundle ${desc.buckets.length}`);
    for (const r of rows) checkState({ table, bucket: r.bucket, day: "start", part: "end" }, { count: r.count, hash: BigInt(`0x${r.hash}`) }, desc.buckets[r.bucket], "start.json");
  }
}

// A retired spec only lets restore write the file of a table the bundle still holds; the file is a blob here.
async function packFiles({ slug, kind, layout, root, specs: allSpecs, views, start, config }) {
  const specs = allSpecs.filter((s) => !s.retired);
  const { files } = await listCoinFiles({ root, layout, kind });
  const tablePaths = new Set(specs.map((s) => s.path));
  for (const spec of specs) if (!files.includes(spec.path)) throw new PackStepError(slug, "pack", `table ${spec.table}: its file ${spec.path} is not among the files of kind ${kind}`);
  const blobPart = await packBlobs({
    paths: files.filter((f) => !tablePaths.has(f)), root, views, startItems: start?.items ?? null,
    previous: start?.bundle.blobs ?? {}, day: config.day, carryDays: config.historyDays - CARRY_MARGIN_DAYS,
  });
  const tables = {};
  const descriptors = {};
  const stats = { blobs: blobPart.stats, tables: {} };
  const hashes = { ...blobPart.files };
  const tableFiles = {};
  for (const spec of specs) {
    const store = createTableStore({ views, startItems: start?.items ?? null, table: spec.table });
    const done = await packTable({
      slug, spec, root, store, index: start?.index?.tables[spec.table] ?? null, day: dayNumber(config.day), spoolDir: config.spoolDir,
      indexOptions: { historyDays: config.historyDays, ...config.indexOptions }, trace: config.trace,
    });
    tables[spec.table] = done.index;
    descriptors[spec.table] = tableDescriptor(done.index, done.header);
    stats.tables[spec.table] = done.stats;
    hashes[spec.path] = await hashFile(path.resolve(root, spec.path));
    tableFiles[spec.table] = { path: spec.path, sha256: hashes[spec.path] };
  }
  return { blobs: blobPart.blobs, tables, descriptors, tableFiles, files: hashes, stats };
}

export function createLanePacker({ kind, blobs, run, lane, day, root, startDir, candidateDir, spoolDir, git, layoutFor, specsFor, usedFor = () => ({}), historyDays = DEFAULT_HISTORY_DAYS, indexOptions = {}, groupSize = PACK_COIN_LIMIT, trace = null }) {
  const config = { day, historyDays, spoolDir, indexOptions, trace };
  const nameFor = ({ cls, flush }) => packName({ cls, kind, day, run: run.id, attempt: run.attempt, lane, flush });
  const laneStores = createLane({ blobs, nameFor, stores: [{ name: "items", cls: "live" }, { name: "hist", cls: "hist" }, { name: "bundles", cls: "live" }], spoolDir: null });
  const results = new Map();
  const candidates = [];
  const taken = new Set();
  let pending = [];

  async function prepare(slug) {
    const rec = await readStartRecord(startDir, slug);
    const { entry, start } = await startOf({ blobs, git, slug, kind, rec });
    checkStartRecord({ slug, rec, start });
    const views = laneStores.forCoin(slug);
    const packed = await packFiles({ slug, kind, layout: layoutFor(slug), root, specs: specsFor(slug), views, start, config });
    return { slug, rec, entry, start, packed };
  }

  async function finishCoin(p, uploaded) {
    const views = laneStores.forCoin(p.slug);
    const known = new Map([...knownRows(p.start), ...uploaded]);
    const rowsFor = (names) => [...names].filter((n) => known.has(n)).map((n) => ({ ...known.get(n) }));
    const hasTables = Object.keys(p.packed.tables).length > 0;
    let stateIndex = null;
    if (hasTables) {
      const missing = [...packNamesIn(p.packed.tables)].filter((n) => !known.has(n));
      if (missing.length > 0) throw new PackStepError(p.slug, "pack", `packs ${missing.join(", ")} have no uploaded row`);
      const bytes = serializeStateIndex({ tables: p.packed.tables, files: p.packed.tableFiles, packs: rowsFor(packNamesIn(p.packed.tables)) });
      stateIndex = await views.bundles.put(bytes, { type: "index" });
    }
    const named = packNamesIn([p.packed.blobs, p.packed.descriptors, stateIndex]);
    const bundle = buildBundle({
      slug: p.slug, kind, day, run, parent: p.entry ? entryKey(p.entry) : null,
      usage: nextUsage({ parent: p.entry?.usage ?? null, day, used: usedFor(p.slug) }),
      blobs: p.packed.blobs, tables: p.packed.descriptors, stateIndex, packs: rowsFor(named),
    });
    return { bundle, put: await writeBundle(views.bundles, bundle) };
  }

  async function flushGroup() {
    if (pending.length === 0) return;
    const group = pending;
    pending = [];
    await laneStores.closeStores(["items", "hist"]);
    const uploaded = new Map(laneStores.rows().map((r) => [r.name, r]));
    const lost = new Set(laneStores.lostCoins());
    const made = [];
    for (const p of group) {
      try {
        if (lost.has(p.slug)) throw new PackStepError(p.slug, "pack", "a pack holding its items failed to upload");
        made.push({ p, ...(await finishCoin(p, uploaded)) });
      } catch (err) {
        if (isProgrammingError(err)) throw err;
        results.set(p.slug, failedRow(p.slug, err, "pack"));
      }
    }
    const closed = await laneStores.closeStores(["bundles"]);
    const coins = {};
    for (const { p, bundle, put } of made) {
      const entry = buildEntry({ slug: p.slug, kind, bundleRef: bundleRefOf(put, closed.packs), bundle });
      coins[p.slug] = { chain: [...p.rec.chain, entry], files: p.packed.files };
      results.set(p.slug, { status: "packed", slug: p.slug, day, bundle: entry.bundle.ref, chain: p.rec.chain.length + 1, stats: p.packed.stats });
    }
    if (made.length === 0) return;
    const file = path.join(candidateDir, `candidate-${kind}-l${lane}f${candidates.length}-a${run.attempt}.json`);
    await fs.mkdir(candidateDir, { recursive: true });
    // A crash mid-write must not leave a truncated candidate under its real name.
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tmp, serializeCandidate(buildCandidate({ kind, run, coins })));
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    candidates.push(file);
  }

  // A failed coin's open items are closed so the lane can go on; if that fails too, the row says both.
  async function failCoin(slug, err) {
    let failure = err;
    try {
      await laneStores.endCoin(slug, ["items", "hist"]);
    } catch (closeErr) {
      if (isProgrammingError(closeErr)) throw closeErr;
      failure = new PackStepError(slug, "pack", `${err.message}; closing its items failed too: ${closeErr.message}`, { cause: err });
    }
    results.set(slug, failedRow(slug, failure, "pack"));
  }

  return {
    async packCoin(slug) {
      if (taken.has(slug)) throw new DuplicateCoinError(slug);
      taken.add(slug);
      try {
        const prepared = await prepare(slug);
        await laneStores.endCoin(slug, ["items", "hist"]);
        pending.push(prepared);
      } catch (err) {
        if (isProgrammingError(err)) throw err;
        await failCoin(slug, err);
        return;
      }
      if (pending.length >= groupSize) await flushGroup();
    },
    async finish() {
      await flushGroup();
      return { coins: Object.fromEntries([...results].sort(([a], [b]) => (a < b ? -1 : 1))), candidates: [...candidates], packs: laneStores.rows().map((r) => ({ name: r.name, size: r.size, items: r.items })) };
    },
  };
}
