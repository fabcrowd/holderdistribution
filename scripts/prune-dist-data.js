#!/usr/bin/env node
/**
 * postbuild: drop never-browser-fetched pipeline files from dist/data
 * (tel-holders*.json, cex-wallets.json, holders-checkpoint.json,
 * holders-ever-checkpoint.json, funding-wallets.json, …). They stay in the repo
 * for the pipeline; the site just stops publishing ~80 MB of wallet-level state.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BROWSER_DATA_FILES } from "./lib/browserDataFiles.js";

export async function pruneDistData(dir = path.resolve(process.cwd(), "dist/data")) {
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
    await fs.rm(path.join(dir, e.name), { recursive: true, force: true });
    removed.push(e.name);
  }
  return { removed: removed.sort(), kept: kept.sort() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { removed, kept } = await pruneDistData();
  console.log(`prune-dist-data: kept ${kept.length} feeds, removed ${removed.length}: ${removed.join(", ")}`);
}
