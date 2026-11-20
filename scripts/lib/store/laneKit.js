// Test helpers for the lane tests (laneRestore, lanePack, laneNights): a JSON table format, fixture
// generators, a git seam over in-memory manifests and the publish step as a test helper (acceptChain
// then manifest entries, as publish.js will do; this is not publish.js). Not a test file itself. Neutral
// slugs only. The format holds a whole table in memory because the fixtures are small: a real format
// streams (laneTables.js header).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptChain } from "./acceptChain.js";
import { parseCandidate } from "./candidate.js";
import { emptyManifest, entryFor, published, serializeManifest, withEntry } from "./manifest.js";
import { coinLayout } from "../storeFiles.js";
import { createLanePacker } from "./lanePack.js";
import { restoreLane } from "./laneRestore.js";

export const KIND = "holders";
export const SLUGS = ["coin-a", "coin-b", "coin-c"];
export const AT = "2026-11-20T03:00:00Z";
export const layoutOf = (slug, slugs = SLUGS) => coinLayout({ slug, dataDir: `public/data/${slug}`, workDir: `data/${slug}`, slugs });
export const tablePath = (slug) => `public/data/${slug}/accounts.json`;

export const jsonTable = {
  async readHeader(file) {
    return JSON.parse(fs.readFileSync(file, "utf8")).header;
  },
  async *readRows(file) {
    for (const [key, ...v] of JSON.parse(fs.readFileSync(file, "utf8")).rows) yield [key, v.map(BigInt)];
  },
  async write(file, header, buckets) {
    const rows = [];
    for await (const b of buckets) for (const [k, v] of b.rows) rows.push([k, ...v.map(String)]);
    rows.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ header, rows }));
  },
};

// `retired`: the table is no longer packed as a table; its spec only gives restore the format to write the file.
export const specsOf = (slug, rowsPerBucket = 6, { format = jsonTable, retired = false } = {}) => [
  { table: "acct", path: tablePath(slug), fields: 2, rowsPerBucket, format, ...(retired ? { retired: true } : {}) },
];

// The bytes jsonTable.write gives for night n's accounts (a table file as a plain blob, before it had a spec).
export function tableText(slug, night) {
  const rows = [...accountsOf(slug, night)].map(([k, v]) => [k, ...v.map(String)]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return JSON.stringify({ header: { asOf: `night-${night}`, decimals: 18 }, rows });
}

export function put(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

// Accounts of night n: a growing set with some balances changed and some removed, the same every run.
export function accountsOf(slug, night) {
  const rows = new Map();
  const count = 12 + 9 * night;
  for (let i = 0; i < count; i++) {
    if (night > 1 && i % 7 === night) continue;
    rows.set(`0x${(i * 2654435761 % 2 ** 32).toString(16).padStart(8, "0")}${slug.length}`, [BigInt(100 + i + (i % 3 === 0 ? night * 5 : 0)), BigInt(i % 4 === 0 ? night : 0)]);
  }
  return rows;
}

export async function writeNightFiles(root, slug, night, { extra = {}, table = true } = {}) {
  const rows = accountsOf(slug, night);
  const asOf = `night-${night}`;
  if (table) await jsonTable.write(path.join(root, tablePath(slug)), { asOf, decimals: 18 }, (async function* () { yield { bucket: 0, rows }; })());
  put(root, `public/data/${slug}/summary.json`, JSON.stringify({ night, holders: rows.size }));
  put(root, `public/data/${slug}/nested/static.json`, JSON.stringify({ fixed: true, slug }));
  put(root, `data/${slug}/checkpoint.json`, JSON.stringify({ block: 1000 + Math.floor((night + 1) / 2) }));
  put(root, `public/data/${slug}/.gitkeep`, "");
  for (const [rel, content] of Object.entries(extra)) put(root, rel, content);
}

// Every stored file of a coin as path -> bytes (the restore's output is compared with it).
export function snapshot(root, slug) {
  const out = new Map();
  const walk = (dir) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name !== ".gitkeep") out.set(`${dir}/${e.name}`, fs.readFileSync(path.join(abs, e.name)));
    }
  };
  walk(`public/data/${slug}`);
  walk(`data/${slug}`);
  return out;
}

// The git seam over a world that holds manifests (Map slug -> manifest) and the live release tag.
export function gitSeam(state, { commits = [] } = {}) {
  return {
    readManifest: async (slug) => (state.manifests.has(slug) ? serializeManifest(state.manifests.get(slug)) : null),
    readStoreFile: async () => (state.liveTag ? `${JSON.stringify({ schema: 1, releases: { live: state.liveTag } })}\n` : null),
    firstParentHistory: async () => ({ commits, complete: true }),
    isAncestor: async () => true,
  };
}

// The origin/main facts as the files fileGit reads (laneCli.js): every file a lane needs, a coin with no
// manifest on main marked by `manifests/<slug>.absent`. `manifests` maps slug -> manifest text, or null for no manifest.
export function writeOriginFacts(dir, { manifests = {}, store = `${JSON.stringify({ schema: 1, releases: {} })}\n`, history = { commits: [], complete: true }, head = [] } = {}) {
  put(dir, "history.json", JSON.stringify(history));
  put(dir, "head-commits.txt", head.map((s) => `${s}\n`).join(""));
  if (store !== null) put(dir, "manifests/store.json", store);
  for (const [slug, text] of Object.entries(manifests)) {
    if (text === null) put(dir, `manifests/${slug}.absent`, "");
    else put(dir, `manifests/${slug}.json`, text);
  }
}

// The publish step as the design 9.2 describes it for entries: per coin of the given candidate files
// (a coin named in `skip` is left out, as if its publish lost the race), acceptChain against the
// manifest entry, then the manifest takes the last chain entry. Returns { accepted, refused }.
export async function publishCandidates({ blobs, state, files, skip = [] }) {
  const accepted = [];
  const refused = [];
  for (const file of files) {
    const cand = parseCandidate(fs.readFileSync(file, "utf8"));
    for (const [slug, coin] of Object.entries(cand.coins)) {
      if (skip.includes(slug)) continue;
      const m = state.manifests.get(slug) ?? emptyManifest(slug);
      const main = entryFor(m, KIND);
      const res = await acceptChain({ blobs, slug, kind: KIND, main, chain: coin.chain });
      if (res.status !== "accepted") {
        refused.push({ slug, ...res });
        continue;
      }
      state.manifests.set(slug, withEntry(m, KIND, published(res.entries.at(-1), AT)));
      state.files.set(slug, coin.files);
      accepted.push(slug);
    }
  }
  return { accepted, refused };
}

export const DAYS = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];
export const asHex = (snap) => [...snap].map(([k, v]) => [k, v.toString("hex")]).sort(([a], [b]) => (a < b ? -1 : 1));

export async function liveTagOf(blobs) {
  const { releases } = await blobs.listReleaseTags("live");
  return releases.length === 0 ? null : [...releases].sort((a, b) => a.seq - b.seq).at(-1).tag;
}

// One lane's world: the manifests of main, a clock and a git seam over them, and temporary directories
// (cleanup removes them). `env` is a recordKit folderEnv or releaseEnv.
// `tables`: true (the coin's table is a table), false (no table spec) or "retired" (a spec that only restores).
export function createHarness(env, { slugs = SLUGS, commits = [], tables = true, format = jsonTable } = {}) {
  const specs = (slug, rowsPerBucket) => (tables ? specsOf(slug, rowsPerBucket, { format, retired: tables === "retired" }) : []);
  const state = { manifests: new Map(), files: new Map(), liveTag: null };
  const dirs = [];
  const tmp = (name) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `lane-${name}-`));
    dirs.push(d);
    return d;
  };
  const clock = env.server ? () => env.server.clock.t : () => Date.now();
  const git = gitSeam(state, { commits });
  return {
    env, state, clock, git, tmp, slugs,
    cleanup() {
      dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
      env.cleanup();
    },
    async start(n, over = {}) {
      const outDir = over.outDir ?? tmp(`out${n}`);
      const startDir = over.startDir ?? tmp(`start${n}`);
      const r = await restoreLane({
        kind: KIND, slugs, blobs: env.blobs, git: over.git ?? git, now: clock, attemptStart: new Date(clock()), outDir, startDir,
        layoutFor: (slug) => layoutOf(slug, slugs), specsFor: (slug) => specs(slug, over.rowsPerBucket), sleep: async () => {}, ...over.lane,
      });
      return { outDir, startDir, r };
    },
    // Writes the night's files (extra: { slug: { path: content } }) then packs every coin of `only`.
    async pack(n, { outDir, startDir, extra = {}, only = slugs, rowsPerBucket, generate = true, historyDays, indexOptions, used = { providerA: 3 }, runId = 100 + n, day = DAYS[n - 1], trace }) {
      const candidateDir = tmp(`cand${n}`);
      if (generate) for (const slug of slugs) await writeNightFiles(outDir, slug, n, { extra: extra[slug], table: tables });
      const after = Object.fromEntries(slugs.map((s) => [s, snapshot(outDir, s)]));
      const packer = createLanePacker({
        kind: KIND, blobs: env.blobs, run: { id: runId, attempt: 1, workflow: "refresh-holders.yml" }, lane: 0, day, root: outDir, startDir,
        candidateDir, spoolDir: tmp(`spool${n}`), git, layoutFor: (slug) => layoutOf(slug, slugs), specsFor: (slug) => specs(slug, rowsPerBucket),
        usedFor: () => used, historyDays, indexOptions, trace,
      });
      for (const slug of only) await packer.packCoin(slug);
      const out = await packer.finish();
      state.liveTag = await liveTagOf(env.blobs);
      return { out, after, candidateDir };
    },
  };
}
