#!/usr/bin/env node
/**
 * store-overlay.js: builds the origin facts as they will be after the publish (design 2.1 section 9.1, step 4).
 *
 *   node scripts/store-overlay.js --origin-dir <dir> --published-dir <dir> --out-dir <dir>
 *
 * Copies the pre-publish origin facts to --out-dir, copies the published manifests on top, and removes
 * manifests/<slug>.absent for every manifests/<slug>.json the publish wrote (a new coin has the marker in the
 * origin facts; the restore check refuses a slug that has both files).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { LaneArgError, need, parseLaneArgs } from "./lib/store/laneCli.js";

const KNOWN = ["origin-dir", "published-dir", "out-dir"];

export function overlay({ originDir, publishedDir, outDir }) {
  fs.cpSync(originDir, outDir, { recursive: true });
  const published = path.join(publishedDir, "manifests");
  if (!fs.existsSync(published)) return [];
  const manifestsOut = path.join(outDir, "manifests");
  fs.mkdirSync(manifestsOut, { recursive: true });
  fs.cpSync(published, manifestsOut, { recursive: true });
  const cleared = [];
  for (const name of fs.readdirSync(published)) {
    if (!name.endsWith(".json")) continue;
    const marker = path.join(manifestsOut, `${name.slice(0, -".json".length)}.absent`);
    if (fs.existsSync(marker)) { fs.rmSync(marker); cleared.push(path.basename(marker)); }
  }
  return cleared;
}

export function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = parseLaneArgs(argv, KNOWN);
  need(args, KNOWN);
  const cleared = overlay({ originDir: path.resolve(args["origin-dir"]), publishedDir: path.resolve(args["published-dir"]), outDir: path.resolve(args["out-dir"]) });
  logger.log(`overlay: ${cleared.length} absent marker(s) cleared`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); } catch (err) {
    console.error(`[store-overlay] ${err.message}`);
    process.exitCode = err instanceof LaneArgError ? 2 : 1;
  }
}
