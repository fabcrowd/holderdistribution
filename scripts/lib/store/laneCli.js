// What the two lane CLIs (scripts/store-restore.js, scripts/store-pack.js) share: argument parsing, the
// layout of a coin from the registry, the blob store from the environment, and the git seam made of
// files. Nothing here runs git (gitReadGuard.test.js): a workflow step writes the origin/main facts into
// a directory and the CLI reads them back. Every fact is required; a missing file stops the lane (or the
// coin, for the coin's own file) with OriginFactsError, because an empty answer would start coins from nothing:
//   <origin-dir>/manifests/<slug>.json     the coin's manifest on origin/main, or
//   <origin-dir>/manifests/<slug>.absent   an empty file the workflow writes when main has no manifest for the coin
//   <origin-dir>/manifests/store.json      store.json on origin/main (the empty store file when main has none)
//   <origin-dir>/history.json              { commits: [{ sha, committedAt, files }], complete: true | false }
//                                          first-parent history of guarded paths; the step says itself whether it is complete
//   <origin-dir>/head-commits.txt          the shas of the commits that are in the job's commit, one a line (may be empty)
// Blob store: `--store-dir <dir>` (a folder backend, for a local run) or the release backend for
// GITHUB_REPOSITORY ("owner/name") with GITHUB_TOKEN.
import fs from "node:fs";
import path from "node:path";
import { folderBackend } from "./blobStoreFolder.js";
import { releaseBackend } from "./blobStoreRelease.js";
import { coinLayout } from "../storeFiles.js";
import { loadRegistry, projectDataDir, projectWorkDir, resolveProject } from "../projects.js";
import { ledgerOutRelDir } from "../ledger/config.js";
import { OriginFactsError } from "./laneNames.js";

export class LaneArgError extends Error {
  constructor(message) {
    super(`lane: ${message}`);
    this.name = "LaneArgError";
  }
}

const MULTI = new Set(["project"]);

// --name value pairs; `--project` may repeat or hold a comma list. Unknown names are an error.
export function parseLaneArgs(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith("--") ? argv[i].slice(2) : null;
    if (!name || !known.includes(name)) throw new LaneArgError(`unknown argument ${JSON.stringify(argv[i])} (known: ${known.map((k) => `--${k}`).join(", ")})`);
    if (argv[i + 1] === undefined) throw new LaneArgError(`--${name} needs a value`);
    if (MULTI.has(name)) out[name] = [...(out[name] ?? []), ...argv[i + 1].split(",").filter(Boolean)];
    else out[name] = argv[i + 1];
  }
  const twice = (out.project ?? []).find((s, i, all) => all.indexOf(s) !== i);
  if (twice) throw new LaneArgError(`--project names ${twice} twice`);
  return out;
}

export function need(args, names) {
  for (const n of names) if (args[n] === undefined || (Array.isArray(args[n]) && args[n].length === 0)) throw new LaneArgError(`--${n} is required`);
}

// A coin's roots are shared when another registered coin's data directory lies below its own.
export function layoutFromRegistry(slug, root) {
  const slugs = loadRegistry(root).map((p) => p.slug);
  const project = resolveProject(slug, root);
  return coinLayout({
    slug, dataDir: project.dataDir, workDir: projectWorkDir(project), sharedRoots: slugs.some((o) => o !== slug && projectDataDir(o, root).startsWith(`${project.dataDir}/`)), slugs, ledgerDir: ledgerOutRelDir(slug),
    excludedFiles: project.config?.excludedFiles ?? [],
  });
}

export function backendFor({ args, env = process.env, http = fetch }) {
  if (args["store-dir"]) return folderBackend(path.resolve(args["store-dir"]));
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo || !env.GITHUB_TOKEN) throw new LaneArgError("no --store-dir and no GITHUB_REPOSITORY / GITHUB_TOKEN: the blob store cannot be reached");
  return releaseBackend({ owner, repo, token: env.GITHUB_TOKEN, http, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
}

function requiredFile(dir, rel) {
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) throw new OriginFactsError(`${rel} is missing from ${dir}`);
  return fs.readFileSync(file, "utf8");
}

function historyOf(dir) {
  const text = requiredFile(dir, "history.json");
  let v;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new OriginFactsError(`history.json is not JSON (${err.message})`);
  }
  if (!v || !Array.isArray(v.commits) || typeof v.complete !== "boolean") throw new OriginFactsError("history.json must be { commits: [...], complete: true | false }");
  return { commits: v.commits, complete: v.complete };
}

// The coin's manifest text, or null when the workflow wrote the marker for "no manifest on main". Neither
// file, or both, is an error: a missing file must never read as a new coin.
function manifestOf(dir, slug) {
  const json = `manifests/${slug}.json`;
  const marker = `manifests/${slug}.absent`;
  const [hasJson, hasMarker] = [json, marker].map((rel) => fs.existsSync(path.join(dir, rel)));
  if (hasJson && hasMarker) throw new OriginFactsError(`${json} and ${marker} are both in ${dir}`);
  if (hasMarker) return null;
  if (!hasJson) throw new OriginFactsError(`${json} is missing from ${dir}, and so is the marker ${marker}`);
  return fs.readFileSync(path.join(dir, json), "utf8");
}

export function fileGit(dir) {
  return {
    readManifest: async (slug) => manifestOf(dir, slug),
    readStoreFile: async () => requiredFile(dir, "manifests/store.json"),
    // head-commits.txt is the guard's other input: checked here too, so a lane with no commits to ask about still fails closed.
    firstParentHistory: async () => {
      requiredFile(dir, "head-commits.txt");
      return historyOf(dir);
    },
    isAncestor: async (sha) => requiredFile(dir, "head-commits.txt").split("\n").some((l) => l.trim() === sha),
  };
}

// --table-specs <module>: a module exporting tableSpecsFor(slug, layout) -> table specs (laneTables.js);
// none given: the coin has no table, every stored file is a blob.
export async function specsLoader(args) {
  if (!args["table-specs"]) return () => [];
  const mod = await import(path.resolve(args["table-specs"]));
  if (typeof mod.tableSpecsFor !== "function") throw new LaneArgError(`${args["table-specs"]} does not export tableSpecsFor(slug, layout)`);
  return mod.tableSpecsFor;
}

export function printReport(logger, title, coins) {
  const rows = Object.values(coins);
  logger.log(`${title}: ${rows.filter((r) => r.status !== "failed").length} ok, ${rows.filter((r) => r.status === "failed").length} failed`);
  for (const r of rows) {
    if (r.status === "failed") logger.error(`  FAILED ${r.slug} [${r.stage}] ${r.error}: ${r.message}`);
    else logger.log(`  ${r.status} ${r.slug}`);
  }
}
