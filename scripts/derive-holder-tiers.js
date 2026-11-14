#!/usr/bin/env node
/**
 * Print holder tiers for one project, derived from that project's own snapshot.
 * Read-only: paste the printed `distributionTiers`, `balanceRanges`,
 * `megaHolderThreshold`, `retailThreshold` and `concentrationBuckets` into the
 * project's `holders` block in config/projects/<slug>.json.
 *
 *   node scripts/derive-holder-tiers.js --project <slug>
 *   node scripts/derive-holder-tiers.js --balances <file.tsv>   (address<TAB>balance per line, e.g. a scratch dry run)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveHolderTiers, MAX_TIER_SHARE } from "./lib/deriveHolderTiers.js";
import { projectDataPath, resolveProject } from "./lib/projects.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const slug = arg("--project");
// resolveProject + projectDataPath, so TEL's legacy root (public/data/) resolves like every other script.
const project = slug ? resolveProject(slug, ROOT) : null;

function readBalances() {
  const tsv = arg("--balances");
  if (tsv) {
    return fs
      .readFileSync(tsv, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => Number(line.split("\t")[1]));
  }
  if (!project) throw new Error("usage: --project <slug> | --balances <file.tsv> [--project <slug> for the supply target]");
  const file = projectDataPath(project, "tel-holders.json", ROOT);
  if (!fs.existsSync(file)) throw new Error(`${file} not found: run the first holders snapshot for ${project.slug}, or pass --balances`);
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  return (snapshot.wallets ?? []).map((w) => Number(w.total_telcoin_balance));
}

const result = deriveHolderTiers(readBalances(), { supplyTarget: project?.config?.supply?.target });
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const { distributionTiers, balanceRanges, megaHolderThreshold, retailThreshold, concentrationBuckets } = result;
console.log(JSON.stringify({ distributionTiers, balanceRanges, megaHolderThreshold, retailThreshold, concentrationBuckets }, null, 2));
console.error(`\n${result.holders.toLocaleString()} holders. Share of wallets per distribution tier:`);
for (const [label, share] of Object.entries(result.tierShares)) console.error(`  ${label.padEnd(14)} ${pct(share)}`);
if (result.largestTierShare > MAX_TIER_SHARE) {
  console.error(`One tier holds ${pct(result.largestTierShare)} of wallets (limit ${pct(MAX_TIER_SHARE)}).`);
  process.exit(1);
}
