/**
 * postbuild: shape dist/data for the multi-token layout.
 *
 *   1. Drop never-browser-fetched pipeline files (tel-holders*.json,
 *      cex-wallets.json, holders-checkpoint.json, holders-ever-checkpoint.json,
 *      funding-wallets.json, …) at the root AND inside every project folder.
 *      They stay in the repo for the pipeline; the site just stops publishing
 *      ~80 MB of wallet-level state.
 *   2. Keep dist/data/<slug>/ for every registered project (browser feeds only);
 *      any other folder (e.g. wallet-analysis) is removed.
 *   3. For "legacyRoot" projects (TEL: pipelines still write public/data/),
 *      copy the root feeds into dist/data/<slug>/ so /data/<slug>/<feed> is
 *      the one URL scheme for every token. The root copies stay for old
 *      bundles and links that still ask for /data/<feed>.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BROWSER_DATA_FILES } from "./lib/browserDataFiles.js";
import { legacyRootSlugs, loadRegistry } from "./lib/projects.js";

async function pruneDir(dir, { keepDirs = new Set() } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: [], kept: [] };
  }
  const removed = [];
  const kept = [];
  for (const e of entries) {
    if (e.isFile() && BROWSER_DATA_FILES.has(e.name)) {
      kept.push(e.name);
      continue;
    }
    if (e.isDirectory() && keepDirs.has(e.name)) continue;
    await fs.rm(path.join(dir, e.name), { recursive: true, force: true });
    removed.push(e.name);
  }
  return { removed: removed.sort(), kept: kept.sort() };
}

export async function pruneDistData(
  dir = path.resolve(process.cwd(), "dist/data"),
  { slugs = [], legacySlugs = [] } = {},
) {
  const root = await pruneDir(dir, { keepDirs: new Set(slugs) });
  const projects = {};
  for (const slug of slugs) {
    const sub = path.join(dir, slug);
    if (legacySlugs.includes(slug)) {
      await fs.mkdir(sub, { recursive: true });
      for (const f of root.kept) await fs.copyFile(path.join(dir, f), path.join(sub, f));
    }
    projects[slug] = await pruneDir(sub);
  }
  return { ...root, projects };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slugs = loadRegistry().map((p) => p.slug);
  const { removed, kept, projects } = await pruneDistData(undefined, { slugs, legacySlugs: legacyRootSlugs() });
  console.log(`prune-dist-data: kept ${kept.length} root feeds, removed ${removed.length}: ${removed.join(", ")}`);
  for (const [slug, r] of Object.entries(projects)) {
    console.log(`prune-dist-data: /data/${slug}/ has ${r.kept.length} feeds${r.removed.length ? `, removed ${r.removed.join(", ")}` : ""}`);
  }
}
