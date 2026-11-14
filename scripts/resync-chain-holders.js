#!/usr/bin/env node
/**
 * EMERGENCY ONLY — re-syncs public/data/tel-holders.json per-chain holders[]
 * against wallets[] and the current non-retail set (exclusions + CEX + DEX).
 *
 * Routine refreshes already apply exclusions at scan time via
 * pull-holders-rpc.js + scripts/lib/nonRetailSet.js. Prefer a full RPC run.
 * Use this only when exclusions changed and a rescan is not practical.
 *
 * Metrics (holderCount / retail / underThreshold / totalBalance) are always
 * recomputed via computeChainMetrics (scripts/lib/holderMetrics.js, called from resyncSnapshot in
 * scripts/lib/snapshotFormat.js) — never set retail.count = kept.length.
 *
 * A single-chain (slim) snapshot is hydrated first and written back slim; see snapshotFormat.js.
 *
 * Idempotent for holders lists; metrics are rewritten whenever they drift.
 *
 * Usage: node scripts/resync-chain-holders.js [--dry-run]
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadNonRetailSet } from "./lib/nonRetailSet.js";
import { buildSummary } from "./lib/holderMetrics.js";
import { projectHolderTiers } from "./lib/holderTiers.js";
import { selectPipelineProject, projectPaths, projectNonRetailPaths } from "./lib/projects.js";
import { hydrateChainHolders, resyncSnapshot, serializeVerified } from "./lib/snapshotFormat.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: the project's
// data dir and its own exclusions/CEX/DEX lists — see scripts/lib/projects.js.
const project = selectPipelineProject("resync-chain-holders", { ported: true });
const RETAIL_THRESHOLD = projectHolderTiers(project).retailThreshold;
const data = projectPaths(project);

const HOLDERS_PATH = data("tel-holders.json");
const SUMMARY_PATH = data("holders-summary.json");

const readJson = async (p, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  let snapshot = await readJson(HOLDERS_PATH);
  if (!snapshot) throw new Error("tel-holders.json not found");

  const { set: excluded, sizes } = await loadNonRetailSet(projectNonRetailPaths(project, process.cwd(), snapshot));
  console.log(
    `Non-retail set: ${sizes.total} addresses ` +
      `(exclusions ${sizes.exclusions}, CEX config ${sizes.cex}, DEX config ${sizes.dex}).`,
  );

  // A slim single-chain snapshot has no holders[]: rebuild it, resync, and write back (slim again).
  const { snapshot: resynced, added, removed } = resyncSnapshot(hydrateChainHolders(snapshot), excluded, RETAIL_THRESHOLD);
  snapshot = resynced;

  const summary = buildSummary(snapshot);

  console.log(`Added ${added} holder entr${added === 1 ? "y" : "ies"}, removed ${removed}.`);
  console.log(
    `Retail counts: ` +
      Object.entries(snapshot.chains ?? {})
        .map(([k, c]) => `${k}=${c.metrics?.retail?.count ?? 0}`)
        .join(", ") +
      ` (combined=${snapshot.combined.retail.count})`,
  );

  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }

  // Serialize before writing either file: a refusal (round trip or size gate) leaves both untouched.
  const holdersText = serializeVerified(snapshot, HOLDERS_PATH);
  await fs.writeFile(HOLDERS_PATH, holdersText, "utf8");
  console.log(`Wrote ${HOLDERS_PATH}`);
  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Wrote ${SUMMARY_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
