#!/usr/bin/env node
/**
 * init-forensics-registry.js [--project <slug>] [--dry-run] [--force]
 *
 * Writes a gated project's forensics registry (data/<slug>/forensics/
 * wallet-flows.registry.json) from its config contracts{} entries with role
 * treasury or holdings. Labels and confidence are derived from the config;
 * review them by hand before the gated report is published.
 *
 * --dry-run  print the summary, write nothing
 * --force    overwrite an existing registry file
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { deriveRegistry } from "./lib/forensicsRegistry.js";
import { projectWork, selectPipelineProject } from "./lib/projects.js";
import { WALLET_FLOWS_REGISTRY_FILE } from "./lib/walletFlowsProject.js";

const CONFIDENCE_LEVELS = ["high", "medium", "low"];

const relPosix = (root, file) => path.relative(root, file).split(path.sep).join("/");

const fileExists = async (fsApi, file) => {
  try {
    await fsApi.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const countByConfidence = (wallets) => {
  const counts = Object.fromEntries(CONFIDENCE_LEVELS.map((level) => [level, 0]));
  for (const wallet of wallets) counts[wallet.confidence] = (counts[wallet.confidence] ?? 0) + 1;
  return counts;
};

/**
 * Derive the registry for `project` and write it to the project's work dir.
 * Throws when the project is not gated, has no treasury/holdings wallets, or
 * the file exists without `force`.
 */
export async function writeRegistry(project, { root = process.cwd(), dryRun = false, force = false, fsApi = fs } = {}) {
  const slug = project.slug;
  if (project.config?.gated?.forensics !== true) throw new Error(`${slug}: gated.forensics is not true`);

  const registry = deriveRegistry(project.config);
  if (registry.knownWallets.length === 0) throw new Error(`${slug}: no treasury/holdings wallets in config contracts`);

  const target = projectWork(project, root)(WALLET_FLOWS_REGISTRY_FILE);
  if (!force && (await fileExists(fsApi, target))) {
    throw new Error(`${relPosix(root, target)} exists; pass --force to overwrite`);
  }

  if (!dryRun) {
    await fsApi.mkdir(path.dirname(target), { recursive: true });
    await fsApi.writeFile(target, `${JSON.stringify(registry, null, 1)}\n`, "utf8");
  }

  return {
    path: target,
    wallets: registry.knownWallets.length,
    byConfidence: countByConfidence(registry.knownWallets),
    written: !dryRun,
  };
}

const formatSummary = (root, result) => {
  const { high, medium, low } = result.byConfidence;
  const action = result.written ? "written" : "dry run, nothing written";
  return `${relPosix(root, result.path)}: ${result.wallets} wallets (high ${high}, medium ${medium}, low ${low}); ${action}`;
};

async function main() {
  const root = process.cwd();
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const project = selectPipelineProject("init-forensics-registry", { ported: true });
  const result = await writeRegistry(project, { root, dryRun, force });
  console.log(formatSummary(root, result));
  if (result.byConfidence.low > 0) {
    console.warn(`warning: ${result.byConfidence.low} wallet(s) have low confidence; review the labels in ${relPosix(root, result.path)}.`);
  }
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    await main();
  } catch (error) {
    console.error(`[init-forensics-registry] ${error.message}`);
    process.exitCode = 1;
  }
}
