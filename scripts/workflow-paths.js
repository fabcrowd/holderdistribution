#!/usr/bin/env node
/**
 * workflow-paths.js
 *
 * Prints the selected project's repo-relative pipeline directories as
 * KEY=value lines, for GitHub Actions to append to $GITHUB_ENV:
 *
 *   HD_PROJECT_SLUG=tel
 *   HD_LEGACY_ROOT=true
 *   HD_DATA_DIR=public/data          (others: public/data/<slug>)
 *   HD_WORK_DIR=data                 (others: data/<slug>)
 *   HD_CEX_CONFIG=config/cex-wallets.json   (empty when the project declares none)
 *   HD_SOLANA_FLOWS=false            ("true" when the project declares a Solana chain: gates scan-solana-flows.js)
 *
 * The data workflows' commit steps name files as "$HD_DATA_DIR/<file>" and
 * "$HD_WORK_DIR/<file>", so a TEL run commits exactly the paths it always did
 * (public/data/<file>, data/<file>) and a run with `project=<slug>` commits
 * public/data/<slug>/** and data/<slug>/** instead — never TEL's files.
 *
 * `files` mode maps a workflow's TEL file list onto the selected project, for
 * `git add` / `git diff` in commit steps:
 *
 *   FILES=$(node scripts/workflow-paths.js files public/data/a.json data/b.json)
 *
 *   - TEL (legacyRoot): prints the arguments unchanged, so every TEL commit
 *     step stages exactly the paths it always did.
 *   - any other project: public/data/<f> -> public/data/<slug>/<f>,
 *     data/<f> -> data/<slug>/<f>, a config/ classification root file
 *     (config/cex-wallets.json, …) -> the project's own `classification.*`
 *     file; paths that do not exist (and a classification file the project
 *     does not declare) are dropped, and public/data/<slug> itself is appended
 *     so the run commits public/data/<slug>/** (new feeds and deletions too).
 *     Any other path is refused (exit 2): it would be shared with TEL.
 *
 * Project selection is the same as every pipeline script: --project <slug>,
 * then HD_PROJECT, then the registry default (TEL). Exits 2 on an unknown slug.
 *
 * Run: node scripts/workflow-paths.js [--project <slug>] >> "$GITHUB_ENV"
 *      node scripts/workflow-paths.js [--project <slug>] files <path>...
 */
import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { solanaFlowChains } from "./lib/solana/flowConfig.js";
import {
  pipelineProject,
  projectWorkDir,
  projectClassificationRelPath,
  CLASSIFICATION_KINDS,
} from "./lib/projects.js";

export function workflowPaths(project, root = process.cwd()) {
  return {
    HD_PROJECT_SLUG: project.slug,
    HD_LEGACY_ROOT: project.config?.data?.legacyRoot === true ? "true" : "false",
    HD_DATA_DIR: project.dataDir,
    HD_WORK_DIR: projectWorkDir(project),
    HD_CEX_CONFIG: projectClassificationRelPath(project, "cexWallets", root) ?? "",
    HD_SOLANA_FLOWS: solanaFlowChains(project.config).length > 0 ? "true" : "false",
  };
}

/**
 * Map TEL-layout repo paths onto `project` (see the header). Returns the list
 * to stage; throws on a path outside public/data/, data/ or a classification file.
 */
export function mapWorkflowFiles(project, files, root = process.cwd()) {
  if (project.config?.data?.legacyRoot === true) return [...files];
  const work = projectWorkDir(project);
  const kindByRootFile = Object.fromEntries(Object.entries(CLASSIFICATION_KINDS).map(([kind, file]) => [file, kind]));
  const out = [];
  for (const f of files) {
    let mapped;
    if (f.split("/").includes("..") || path.isAbsolute(f)) throw new Error(`refusing path ${JSON.stringify(f)}`);
    if (f.startsWith("public/data/")) mapped = path.posix.join(project.dataDir, f.slice("public/data/".length));
    else if (f.startsWith("data/")) mapped = path.posix.join(work, f.slice("data/".length));
    else if (kindByRootFile[f]) mapped = projectClassificationRelPath(project, kindByRootFile[f], root);
    else throw new Error(`no per-project mapping for ${JSON.stringify(f)} (it would be shared with TEL)`);
    if (mapped && fs.existsSync(path.resolve(root, mapped)) && !out.includes(mapped)) out.push(mapped);
  }
  if (fs.existsSync(path.resolve(root, project.dataDir)) && !out.includes(project.dataDir)) out.push(project.dataDir);
  return out;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  let project;
  try {
    project = pipelineProject("workflow-paths", { ported: true });
  } catch (err) {
    console.error(`[workflow-paths] ${err.message}`);
    process.exit(2);
  }
  // Strip --project <slug> / --project=<slug> before looking for the mode.
  const rest = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") { i++; continue; }
    if (argv[i].startsWith("--project=")) continue;
    rest.push(argv[i]);
  }
  if (rest[0] === "files") {
    try {
      console.log(mapWorkflowFiles(project, rest.slice(1)).join(" "));
    } catch (err) {
      console.error(`[workflow-paths] ${err.message}`);
      process.exit(2);
    }
  } else {
    for (const [k, v] of Object.entries(workflowPaths(project))) console.log(`${k}=${v}`);
  }
}
