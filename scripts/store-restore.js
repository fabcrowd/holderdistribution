#!/usr/bin/env node
/**
 * store-restore.js: the lane job's start step (design 2.1 section 9.1, start steps 1 to 5).
 *
 *   node scripts/store-restore.js --kind <holders|ledger|walletFlows> --project <slug>[,<slug>...]
 *     --origin-dir <dir> --out-dir <dir> --start-dir <dir> [--store-dir <dir>] [--table-specs <module>]
 *     [--attempt-start <ISO time>]
 *
 * Reads the coin's manifest and store.json from the origin/main facts in --origin-dir (laneCli.js lists the
 * files a workflow step writes there), applies the stale-code guard, adopts unpublished bundles, and
 * restores the start bundle into --out-dir; writes <start-dir>/<slug>/start.json. A coin that fails is
 * reported on stderr and skipped; the exit code is 0 unless no coin could be restored (1) or the
 * arguments are wrong (2). Not wired into any workflow in this slice.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { KINDS } from "./lib/store/packNames.js";
import { restoreLane } from "./lib/store/laneRestore.js";
import { LaneArgError, backendFor, fileGit, layoutFromRegistry, need, parseLaneArgs, printReport, specsLoader } from "./lib/store/laneCli.js";

const KNOWN = ["kind", "project", "origin-dir", "out-dir", "start-dir", "store-dir", "table-specs", "attempt-start"];

export async function main(argv = process.argv.slice(2), { logger = console, env = process.env, now = Date.now, root = process.cwd(), blobs = null, http = fetch } = {}) {
  const args = parseLaneArgs(argv, KNOWN);
  need(args, ["kind", "project", "origin-dir", "out-dir", "start-dir"]);
  if (!KINDS.includes(args.kind)) throw new LaneArgError(`--kind must be one of ${KINDS.join(", ")}`);
  if (args["attempt-start"] !== undefined && args["attempt-start"].trim() === "") throw new LaneArgError("--attempt-start is empty: give an ISO time with a zone, or leave the argument out");
  const loadSpecs = await specsLoader(args);
  const result = await restoreLane({
    kind: args.kind, slugs: args.project, blobs: blobs ?? backendFor({ args, env, http }), git: fileGit(args["origin-dir"]), now,
    attemptStart: new Date(args["attempt-start"] ?? now()), outDir: path.resolve(args["out-dir"]), startDir: path.resolve(args["start-dir"]),
    specsFor: (slug) => loadSpecs(slug, layoutFromRegistry(slug, root)), layoutFor: (slug) => layoutFromRegistry(slug, root),
  });
  printReport(logger, `restore ${args.kind}`, result.coins);
  if (result.adoption) logger.log(`  adoption listing: ${result.adoption.listing.requests} requests, ${result.adoption.listing.tags.length} releases`);
  return Object.values(result.coins).some((c) => c.status !== "failed") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[store-restore] ${err.message}`);
    process.exitCode = err instanceof LaneArgError ? 2 : 1;
  });
}
