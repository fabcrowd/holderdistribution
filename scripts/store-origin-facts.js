#!/usr/bin/env node
/**
 * store-origin-facts.js: a workflow step's way of writing the origin/main facts the store CLIs read
 * (laneCli.js fileGit and publishFiles.js list the files; the CLIs themselves never run git).
 *
 *   node scripts/store-origin-facts.js --out <dir> [--slugs <a,b>] [--slugs-from <candidates dir>] [--ref origin/main]
 *     [--head HEAD] [--since "90 days ago"]
 *
 * Writes into --out, from --ref:
 *   manifests/**.json       every file under data/manifests/ on --ref (coin manifests, store.json, site.json, index/)
 *   manifests/<slug>.absent for each --slugs coin (and each coin named by a candidate under --slugs-from) with no manifest
 *                           on --ref (a missing file must never read as a new coin)
 *   manifests/store.json    the empty store file when --ref has none; manifests/site.json the null-root file when none
 *   history.json            { commits, complete }: git log --first-parent --diff-merges=first-parent --name-only over the
 *                           guarded paths since --since (staleCodeGuard.js header). `complete` is false in a shallow
 *                           checkout, so the stale-code guard refuses instead of passing on a cut-short list.
 *   head-commits.txt        the shas reachable from --head since --since, one a line
 * Needs git 2.31 or newer (--diff-merges). Exit code 1 on any failure, 2 for wrong arguments.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { LaneArgError, parseLaneArgs } from "./lib/store/laneCli.js";

const KNOWN = ["out", "slugs", "slugs-from", "ref", "head", "since"];
const MANIFEST_DIR = "data/manifests";
const GUARDED_PATHS = ["scripts", ".github", "package.json", "package-lock.json"];
const EMPTY_STORE = `${JSON.stringify({ schema: 1, releases: {} }, null, 2)}\n`;
const EMPTY_SITE = `${JSON.stringify({ schema: 1, root: null }, null, 2)}\n`;
const HEADER = /^([0-9a-f]{40,64}) (\d{4}-\d{2}-\d{2}T\S+)$/;

// Output of `git log --first-parent --name-only --format="%H %cI"`: a header line per commit, then its files.
export function parseGitLog(text) {
  const commits = [];
  for (const line of text.split("\n").map((l) => l.trimEnd())) {
    if (line === "") continue;
    const m = HEADER.exec(line);
    if (m) commits.push({ sha: m[1], committedAt: m[2], files: [] });
    else if (commits.length === 0) throw new Error(`git log output starts with ${JSON.stringify(line)}, not a commit header`);
    else commits.at(-1).files.push(line);
  }
  return commits;
}

// The coins named by the candidate artifacts under dir. A file that is not a candidate is skipped here; the publish
// step refuses it with its own error.
export function slugsFromCandidates(dir) {
  const slugs = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".json")) {
        try {
          for (const slug of Object.keys(JSON.parse(fs.readFileSync(full, "utf8")).coins ?? {})) slugs.add(slug);
        } catch {
          // not a candidate: left to the publish step
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return [...slugs].sort();
}

function put(out, rel, text) {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// `git` is (args) => stdout text; injected so the logic is testable without a repository.
export function writeFacts({ out, slugs = [], ref, head, since, git }) {
  const names = git(["ls-tree", "-r", "--name-only", ref, "--", MANIFEST_DIR]).split("\n").filter((n) => n.endsWith(".json"));
  for (const name of names) put(out, name.slice("data/".length), git(["show", `${ref}:${name}`]));
  const have = new Set(names);
  for (const slug of slugs) if (!have.has(`${MANIFEST_DIR}/${slug}.json`)) put(out, `manifests/${slug}.absent`, "");
  if (!have.has(`${MANIFEST_DIR}/store.json`)) put(out, "manifests/store.json", EMPTY_STORE);
  if (!have.has(`${MANIFEST_DIR}/site.json`)) put(out, "manifests/site.json", EMPTY_SITE);
  const log = git(["log", "--first-parent", "--diff-merges=first-parent", "--name-only", "--format=%H %cI", `--since=${since}`, ref, "--", ...GUARDED_PATHS]);
  const complete = git(["rev-parse", "--is-shallow-repository"]).trim() === "false";
  put(out, "history.json", `${JSON.stringify({ commits: parseGitLog(log), complete }, null, 2)}\n`);
  const heads = git(["rev-list", `--since=${since}`, head]).split("\n").filter(Boolean);
  put(out, "head-commits.txt", heads.length ? `${heads.join("\n")}\n` : "");
  return { manifests: names.length, commits: parseGitLog(log).length, complete, heads: heads.length };
}

const runGit = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export function main(argv = process.argv.slice(2), { logger = console, git = runGit } = {}) {
  const args = parseLaneArgs(argv, KNOWN);
  if (!args.out) throw new LaneArgError("--out is required");
  const slugs = [...new Set([...(args.slugs ? args.slugs.split(",").filter(Boolean) : []), ...(args["slugs-from"] ? slugsFromCandidates(args["slugs-from"]) : [])])];
  const r = writeFacts({ out: path.resolve(args.out), slugs, ref: args.ref ?? "origin/main", head: args.head ?? "HEAD", since: args.since ?? "90 days ago", git });
  logger.log(`origin facts: ${r.manifests} manifest files, ${r.commits} guarded commits (complete: ${r.complete}), ${r.heads} head commits`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`[store-origin-facts] ${err.message}`);
    process.exitCode = err instanceof LaneArgError ? 2 : 1;
  }
}
