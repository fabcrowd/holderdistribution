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
import {
  pipelineProject,
  projectWorkDir,
  projectClassificationRelPath,
  projectChainKeysByVm,
  projectStakingContracts,
  loadRegistry,
  resolveProject,
  CLASSIFICATION_KINDS,
} from "./lib/projects.js";

export function workflowPaths(project, root = process.cwd()) {
  return {
    HD_PROJECT_SLUG: project.slug,
    HD_LEGACY_ROOT: project.config?.data?.legacyRoot === true ? "true" : "false",
    HD_DATA_DIR: project.dataDir,
    HD_WORK_DIR: projectWorkDir(project),
    HD_CEX_CONFIG: projectClassificationRelPath(project, "cexWallets", root) ?? "",
  };
}

export const DEFAULT_TIMEOUT_MINUTES = 60;

/**
 * Projects the daily refresh matrix runs: `selection` is a slug, or empty /
 * "all" for every project in config/projects.json (default project first, then
 * registry order). Per-project job timeout comes from
 * `pipeline.workflowTimeoutMinutes`. Under "all" a project whose config is
 * broken is reported in `skipped` instead of throwing, so a half-onboarded
 * token can never stop the others from refreshing; a named slug throws.
 */
export function workflowMatrix(selection, root = process.cwd()) {
  const sel = (selection ?? "").trim();
  const registry = loadRegistry(root);
  const ordered = [...registry].sort((a, b) => Number(b.default === true) - Number(a.default === true));
  const toEntry = (slug) => {
    const project = resolveProject(slug, root);
    return {
      slug,
      ticker: project.config?.ticker ?? slug.toUpperCase(),
      timeout: Number(project.config?.pipeline?.workflowTimeoutMinutes) || DEFAULT_TIMEOUT_MINUTES,
    };
  };
  if (sel && sel !== "all") return { include: [toEntry(sel)], skipped: [] };
  const include = [];
  const skipped = [];
  for (const { slug } of ordered) {
    try {
      include.push(toEntry(slug));
    } catch (err) {
      skipped.push({ slug, error: err.message });
    }
  }
  return { include, skipped };
}

/**
 * Per-project stage differences for the shared refresh job, derived from the
 * project config (never from a slug check in YAML):
 *   HD_TICKER         issue titles
 *   HD_COMMIT_TAG     " [skip netlify]" unless this is the registry default
 *                     project, which stays the one daily publisher
 *                     (scripts/lib/deployTriggers.test.js)
 *   HD_HAS_EVM        any EVM chain: gates the eth_getBlockByNumber gap fill
 *   HD_REQUIRED_FILES feeds the verify step requires in HD_DATA_DIR
 */
export function workflowPlan(project, root = process.cwd()) {
  const required = [
    "tel-holders.json", "holders-summary.json", "holders-history.json", "holders-lite.json", "holders-checkpoint.json",
    "holder-transitions.json", "holders-ever-checkpoint.json", "supply-reconciliation.json", "treasury-history.json",
    "classification-changelog.json", "cex-wallets.json", "cex-flows.json", "cex-balance-history.json",
  ];
  if (projectStakingContracts(project, { kind: "stakeChanged" }).length > 0) required.push("funding-wallets.json");
  if (projectStakingContracts(project, { kind: "zebecStakeV1" }).length > 0) required.push("solana-staking.json");
  const registry = loadRegistry(root);
  const defaultSlug = (registry.find((p) => p.default) ?? registry[0])?.slug;
  return {
    HD_TICKER: project.config?.ticker ?? project.slug.toUpperCase(),
    HD_COMMIT_TAG: project.slug === defaultSlug ? "" : " [skip netlify]",
    HD_HAS_EVM: projectChainKeysByVm(project.config, "evm").length > 0 ? "true" : "false",
    HD_REQUIRED_FILES: required.join(" "),
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
  if (rest[0] === "matrix") {
    // node scripts/workflow-paths.js matrix [<slug>|all] -> {"include":[...]} for a GitHub matrix.
    try {
      const { include, skipped } = workflowMatrix(rest[1]);
      for (const s of skipped) console.error(`::warning::project ${s.slug} skipped: ${s.error}`);
      if (include.length === 0) throw new Error("no runnable projects in config/projects.json");
      console.log(JSON.stringify({ include }));
    } catch (err) {
      console.error(`[workflow-paths] ${err.message}`);
      process.exit(2);
    }
  } else if (rest[0] === "files") {
    try {
      console.log(mapWorkflowFiles(project, rest.slice(1)).join(" "));
    } catch (err) {
      console.error(`[workflow-paths] ${err.message}`);
      process.exit(2);
    }
  } else {
    for (const [k, v] of Object.entries({ ...workflowPaths(project), ...workflowPlan(project) })) console.log(`${k}=${v}`);
  }
}
