#!/usr/bin/env node
/**
 * check-store-files.js: every file a coin writes is stored or excluded by the store.
 *
 *   node scripts/check-store-files.js [--project <slug>[,<slug>...]]     (default: every coin in config/projects.json)
 *
 * Lists each coin's files per kind with the same function the lane pack and restore use
 * (storeFiles.js listCoinFiles, over laneCli.js layoutFromRegistry), so this check and the pack
 * cannot disagree. Prints stored and excluded counts per kind and one UNCLASSIFIED line per file the
 * store can neither store nor exclude. Exit 0 when every file is classified, 1 when any is not,
 * 2 for wrong arguments. Reads the working tree only; offline. A coin with no data yet has no files
 * and passes.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadRegistry } from "./lib/projects.js";
import { LaneArgError, layoutFromRegistry, parseLaneArgs } from "./lib/store/laneCli.js";
import { STORED_KINDS, UnclassifiedFileError, listCoinFiles } from "./lib/storeFiles.js";

export async function checkCoin({ root, layout }) {
  const kinds = {};
  const unclassified = [];
  for (const kind of STORED_KINDS) {
    try {
      const { files, excluded } = await listCoinFiles({ root, layout, kind });
      kinds[kind] = { stored: files.length, excluded: excluded.length };
    } catch (err) {
      if (!(err instanceof UnclassifiedFileError)) throw err;
      kinds[kind] = { stored: null, excluded: null };
      unclassified.push(...err.files.map((f) => ({ kind, path: f.path, why: f.why })));
    }
  }
  return { slug: layout.slug, kinds, unclassified };
}

export function formatCoin(result) {
  const count = (n) => (n === null ? "n/a" : String(n));
  const kinds = Object.entries(result.kinds).map(([k, c]) => `${k} stored ${count(c.stored)} excluded ${count(c.excluded)}`).join(", ");
  const lines = [`${result.unclassified.length === 0 ? "ok  " : "FAIL"} ${result.slug}: ${kinds}`];
  for (const u of result.unclassified) lines.push(`  UNCLASSIFIED ${u.path} (${u.why}) [${u.kind}]`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { logger = console, root = process.cwd() } = {}) {
  try {
    const args = parseLaneArgs(argv, ["project"]);
    const registered = loadRegistry(root).map((p) => p.slug);
    const slugs = args.project ?? registered;
    const unknown = slugs.find((s) => !registered.includes(s));
    if (unknown) throw new LaneArgError(`--project ${unknown} is not in config/projects.json`);
    let failed = 0;
    for (const slug of slugs) {
      const result = await checkCoin({ root, layout: layoutFromRegistry(slug, root) });
      logger.log(formatCoin(result));
      if (result.unclassified.length > 0) failed += 1;
    }
    logger.log(failed === 0 ? `store files: ${slugs.length} coin(s) fully classified` : `store files: ${failed} of ${slugs.length} coin(s) have unclassified files (add a hand-kept file to the coin's excludedFiles, or remove a stray file)`);
    return failed === 0 ? 0 : 1;
  } catch (err) {
    if (!(err instanceof LaneArgError)) throw err;
    logger.error(`[check-store-files] ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[check-store-files] ${err.message}`);
    process.exitCode = 1;
  });
}
