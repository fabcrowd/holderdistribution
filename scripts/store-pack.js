#!/usr/bin/env node
/**
 * store-pack.js: the lane job's end step (design 2.1 section 9.1, end steps 1 to 6; the yearly copy, list
 * versions and the artifact upload are not part of this slice).
 *
 *   node scripts/store-pack.js --kind <holders|ledger|walletFlows> --project <slug>[,<slug>...]
 *     --run-id <n> --attempt <n> --lane <n> --day <YYYY-MM-DD> --root <dir> --start-dir <dir>
 *     --candidate-dir <dir> --spool-dir <dir> --origin-dir <dir> [--store-dir <dir>]
 *     [--table-specs <module>] [--used-file <json: { <slug>: { <provider>: <count> } }>] [--history-days <n>]
 *
 * Lists each coin's stored files, settles blobs, writes the tables' change files, uploads the packs and the
 * bundles through the blob store and writes `candidate-<kind>-l<lane>f<group>-a<attempt>.json` into
 * --candidate-dir (the workflow uploads it as an artifact in a later step). A coin that fails is reported
 * on stderr and skipped; exit code 0 unless no coin was packed (1) or the arguments are wrong (2).
 * Not wired into any workflow in this slice.
 */
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { KINDS } from "./lib/store/packNames.js";
import { createLanePacker } from "./lib/store/lanePack.js";
import { LaneArgError, backendFor, fileGit, layoutFromRegistry, need, parseLaneArgs, printReport, specsLoader } from "./lib/store/laneCli.js";

const KNOWN = ["kind", "project", "run-id", "attempt", "lane", "day", "root", "start-dir", "candidate-dir", "spool-dir", "origin-dir", "store-dir", "table-specs", "used-file", "history-days"];

const whole = (args, name) => {
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n < 0) throw new LaneArgError(`--${name} must be a whole number, got ${JSON.stringify(args[name])}`);
  return n;
};

export async function main(argv = process.argv.slice(2), { logger = console, env = process.env, root = process.cwd(), blobs = null, http = fetch } = {}) {
  const args = parseLaneArgs(argv, KNOWN);
  need(args, ["kind", "project", "run-id", "attempt", "lane", "day", "root", "start-dir", "candidate-dir", "spool-dir", "origin-dir"]);
  if (!KINDS.includes(args.kind)) throw new LaneArgError(`--kind must be one of ${KINDS.join(", ")}`);
  const loadSpecs = await specsLoader(args);
  const used = args["used-file"] ? JSON.parse(fs.readFileSync(args["used-file"], "utf8")) : {};
  const packer = createLanePacker({
    kind: args.kind, blobs: blobs ?? backendFor({ args, env, http }), run: { id: whole(args, "run-id"), attempt: whole(args, "attempt"), workflow: env.GITHUB_WORKFLOW_REF?.split("@")[0].split("/").at(-1) ?? "local" },
    lane: whole(args, "lane"), day: args.day, root: path.resolve(args.root), startDir: path.resolve(args["start-dir"]), candidateDir: path.resolve(args["candidate-dir"]),
    spoolDir: path.resolve(args["spool-dir"]), git: fileGit(args["origin-dir"]), layoutFor: (slug) => layoutFromRegistry(slug, root),
    specsFor: (slug) => loadSpecs(slug, layoutFromRegistry(slug, root)), usedFor: (slug) => used[slug] ?? {},
    ...(args["history-days"] ? { historyDays: whole(args, "history-days") } : {}),
  });
  for (const slug of args.project) await packer.packCoin(slug);
  const out = await packer.finish();
  printReport(logger, `pack ${args.kind}`, out.coins);
  logger.log(`  ${out.packs.length} packs uploaded, ${out.candidates.length} candidate files`);
  return Object.values(out.coins).some((c) => c.status === "packed") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[store-pack] ${err.message}`);
    process.exitCode = err instanceof LaneArgError ? 2 : 1;
  });
}
