#!/usr/bin/env node
/**
 * store-publish.js: the publish job's decision step (design 2.1 section 9.2) and, after the push, its sweep.
 *
 *   node scripts/store-publish.js --phase publish --kind <holders|ledger|walletFlows>
 *     --origin-dir <dir> --candidates-dir <dir> --out-dir <dir> --issues-out <file>
 *     [--store-dir <dir>] [--adoption-alerts <file>] [--run-releases <series=tag,...>]
 *   node scripts/store-publish.js --phase sweep --kind holders
 *     --origin-dir <dir> --issues-out <file> --history-days <n>
 *     [--store-dir <dir>] [--sweep-mode dry|run] [--packs-written <n>] [--delete-releases true|false] [--project <slug,...>]
 *
 * Phase publish: reads the origin/main facts in --origin-dir (publishFiles.js lists the files) and every candidate
 * under --candidates-dir, accepts chains only through acceptChain, and writes into --out-dir the manifests of the
 * accepted coins, the index rows of holders coins and store.json (when a coin was accepted). The workflow then copies
 * --out-dir over the checkout, commits and pushes (steps 6 and 7; not done here).
 * Phase sweep (holders only, after the push landed): origin facts are main as pushed; deletes nothing unless
 * `--sweep-mode run`; the sweep's coins are every manifest on main, the registry's slugs (config/projects.json) and --project.
 * Both phases write --issues-out: { schema: 1, kind, phase, issues: [...] }, the list the workflow raises as GitHub
 * issues (this script makes no gh call). Exit code 0 when the step ran, 1 when an input is missing or bad or the step
 * crashed (the issues file then holds one `crash` issue; --out-dir is built in a sibling directory and moved into place
 * only on success, so it must be missing or empty and a crash leaves nothing in it), 2 for wrong arguments.
 */
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { KINDS } from "./lib/store/packNames.js";
import { LaneArgError, backendFor, need, parseLaneArgs } from "./lib/store/laneCli.js";
import { loadRegistry } from "./lib/projects.js";
import { publishKind } from "./lib/store/publish.js";
import { sweepStore } from "./lib/store/publishSweep.js";
import { manifestSlugs, originSeams, outSeams, readAlerts, readCandidates, readSiteRoot, writeIssues } from "./lib/store/publishFiles.js";

const KNOWN = ["phase", "kind", "origin-dir", "candidates-dir", "out-dir", "issues-out", "store-dir", "adoption-alerts", "run-releases", "history-days", "sweep-mode", "packs-written", "delete-releases", "project"];

const whole = (args, name) => {
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n < 0) throw new LaneArgError(`--${name} must be a whole number, got ${JSON.stringify(args[name])}`);
  return n;
};

function runReleases(text) {
  const out = {};
  for (const pair of (text ?? "").split(",").filter(Boolean)) {
    const [series, tag] = pair.split("=");
    if (!series || !tag) throw new LaneArgError(`--run-releases takes series=tag pairs, got ${JSON.stringify(pair)}`);
    out[series] = tag;
  }
  return out;
}

// --out-dir must be missing or an empty directory: the output is built in a sibling directory and moved there
// only when the whole step succeeded, so a crash leaves nothing in --out-dir.
function checkOutDir(outDir) {
  if (!fs.existsSync(outDir)) return;
  if (!fs.statSync(outDir).isDirectory() || fs.readdirSync(outDir).length > 0) throw new LaneArgError(`--out-dir ${outDir} must be missing or an empty directory`);
}

function moveInto(tmpDir, outDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  if (fs.existsSync(outDir)) fs.rmdirSync(outDir);
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.renameSync(tmpDir, outDir);
}

async function publishPhase(args, { env, http, clock, blobs, logger }) {
  need(args, ["candidates-dir", "out-dir"]);
  const outDir = path.resolve(args["out-dir"]);
  checkOutDir(outDir);
  const tmpDir = `${outDir}.tmp-${process.pid}-${Date.now()}`;
  let result;
  try {
    result = await publishKind({
      kind: args.kind, blobs: blobs ?? backendFor({ args, env, http }), candidates: readCandidates(args["candidates-dir"]), ...originSeams(args["origin-dir"]),
      out: outSeams(tmpDir), clock, runReleases: runReleases(args["run-releases"]),
      ...(args["adoption-alerts"] ? { adoptionAlerts: readAlerts(args["adoption-alerts"]) } : {}),
    });
    moveInto(tmpDir, outDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  logger.log(`publish ${args.kind}: ${result.accepted.length} accepted (${result.accepted.join(", ")}), ${result.results.length - result.accepted.length} not, ${result.issues.length} issues`);
  for (const r of result.results) if (r.status !== "accepted") logger.log(`  ${r.status} ${r.slug}`);
  return result.issues;
}

async function sweepPhase(args, { env, http, clock, blobs, logger, root }) {
  if (args.kind !== "holders") throw new LaneArgError("--phase sweep runs for --kind holders only");
  need(args, ["history-days"]);
  const mode = args["sweep-mode"] ?? "dry";
  if (!["dry", "run"].includes(mode)) throw new LaneArgError("--sweep-mode must be dry or run");
  if (mode === "run") need(args, ["packs-written"]);
  const origin = originSeams(args["origin-dir"]);
  const coins = [...new Set([...manifestSlugs(args["origin-dir"]), ...loadRegistry(root).map((p) => p.slug), ...(args.project ?? [])])].sort();
  const r = await sweepStore({
    blobs: blobs ?? backendFor({ args, env, http }), coins, ...origin, historyDays: whole(args, "history-days"), clock,
    currentSiteRoot: readSiteRoot(args["origin-dir"]), dryRun: mode !== "run", packsWritten: args["packs-written"] === undefined ? 0 : whole(args, "packs-written"),
    ...(args["delete-releases"] === undefined ? {} : { deleteReleases: args["delete-releases"] === "true" }),
  });
  logger.log(`sweep ${mode}: ${r.status}, ${coins.length} coins, ${r.plan ? r.plan.delete.length : 0} packs planned for deletion, ${r.executed ? r.executed.deleted.length : 0} deleted, ${r.issues.length} issues`);
  return r.issues;
}

// A failure that is not a wrong argument is a crash of the step: the issues file still says so before the
// process exits non-zero, so the workflow can raise it.
export async function main(argv = process.argv.slice(2), { logger = console, env = process.env, now = Date.now, blobs = null, http = fetch, root = process.cwd() } = {}) {
  const args = parseLaneArgs(argv, KNOWN);
  need(args, ["kind", "origin-dir", "issues-out"]);
  if (!KINDS.includes(args.kind)) throw new LaneArgError(`--kind must be one of ${KINDS.join(", ")}`);
  const phase = args.phase ?? "publish";
  if (!["publish", "sweep"].includes(phase)) throw new LaneArgError("--phase must be publish or sweep");
  const ctx = { env, http, clock: now, blobs, logger, root };
  let issues;
  try {
    issues = await (phase === "publish" ? publishPhase : sweepPhase)(args, ctx);
  } catch (err) {
    if (!(err instanceof LaneArgError)) {
      writeIssues(args["issues-out"], { schema: 1, kind: args.kind, phase, issues: [{ code: "crash", severity: "error", slug: null, title: `store-publish ${phase} crashed; nothing was published`, detail: `${err.name}: ${err.message}` }] });
    }
    throw err;
  }
  writeIssues(args["issues-out"], { schema: 1, kind: args.kind, phase, issues });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[store-publish] ${err.message}`);
    process.exitCode = err instanceof LaneArgError ? 2 : 1;
  });
}
