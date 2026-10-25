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
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("validate-outputs");

const DATA_DIR = path.resolve(process.cwd(), "public/data");

const required = [
  { file: "tel-holders.json", keys: ["generatedAt", "chains", "combined", "wallets", "source", "chainOrder"] },
  { file: "holders-summary.json", keys: ["generatedAt", "snapshotDate", "combined", "chains"] },
  { file: "holders-history.json", keys: ["generatedAt", "entries"] },
  { file: "cex-wallets.json", keys: ["generatedAt", "wallets", "totals", "source"] },
  { file: "holders-lite.json", keys: ["generatedAt", "source", "views", "chainOrder"] },
];

let failed = 0;
for (const { file, keys } of required) {
  const p = path.join(DATA_DIR, file);
  try {
    const raw = await fs.readFile(p, "utf8");
    const data = JSON.parse(raw);
    const missing = keys.filter((k) => !(k in data));
    if (missing.length) {
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
