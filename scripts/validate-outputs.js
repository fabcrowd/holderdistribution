#!/usr/bin/env node
/**
 * Validates that pipeline output files exist and have required shape.
 * Run after: pull-holders-rpc, pull-cex-wallets, generate-holders-history, generate-holders-lite
 *
 * Canonical CEX source is config/cex-wallets.json; public/data/cex-wallets.json is
 * the derived artifact written by pull-cex-wallets.js (not pull-cex-wallets-static.js).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { selectPipelineProject, projectPaths } from "./lib/projects.js";
import { runForEachProject } from "./lib/feedHealth.js";

// `--all`: once per registered project; fail if any project fails.
if (process.argv.includes("--all")) {
  process.exit(runForEachProject(import.meta.url, process.argv.slice(2).filter((a) => a !== "--all")) > 0 ? 1 : 0);
}

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: validates the
// project's data dir (TEL: public/data/, others: public/data/<slug>/).
const project = selectPipelineProject("validate-outputs", { ported: true });

const DATA_DIR = projectPaths(project, process.cwd()).dir;

const required = [
  { file: "tel-holders.json", keys: ["generatedAt", "chains", "combined", "wallets", "source", "chainOrder"] },
  { file: "holders-summary.json", keys: ["generatedAt", "snapshotDate", "combined", "chains"] },
  { file: "holders-history.json", keys: ["generatedAt", "entries"] },
  { file: "cex-wallets.json", keys: ["generatedAt", "wallets", "totals", "source"] },
  { file: "holders-lite.json", keys: ["generatedAt", "source", "views", "chainOrder"] },
];

/** Why a holders-lite `networkStake` block is unusable, or null. Absent is fine; present must be real data or say it is unavailable. */
const networkStakeProblem = (n) => {
  if (n?.available === false) return typeof n.reason === "string" && n.reason ? null : "is unavailable but gives no reason";
  if (n?.available !== true) return "has no boolean `available`";
  if (!(Number.isFinite(n.stakedTotal) && n.stakedTotal > 0)) return "is available without a positive stakedTotal";
  const { start, end } = n.stakingPeriod ?? {};
  return Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) ? null : "is available without a staking period";
};

let failed = 0;
for (const { file, keys } of required) {
  const p = path.join(DATA_DIR, file);
  try {
    const raw = await fs.readFile(p, "utf8");
    const data = JSON.parse(raw);
    const missing = keys.filter((k) => !(k in data));
    const stakeProblem = file === "holders-lite.json" && "networkStake" in data ? networkStakeProblem(data.networkStake) : null;
    if (stakeProblem) {
      console.error(`FAIL ${file}: networkStake ${stakeProblem}`);
      failed++;
    } else if (missing.length) {
      console.error(`FAIL ${file}: missing keys: ${missing.join(", ")}`);
      failed++;
    } else {
      console.log(`OK   ${file}`);
    }
  } catch (err) {
    console.error(`FAIL ${file}: ${err.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
