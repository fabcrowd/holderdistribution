#!/usr/bin/env node
/**
 * sync-classification-changelog.js
 *
 * Copies the hand-curated config/classification-changelog.json into
 * public/data/ so the frontend can fetch it, timestamping the copy.
 *
 * Any change to config/exclusions.json, config/cex-wallets.json,
 * config/dex-contracts.json, or a hardcoded threshold/definition in
 * scripts/lib/holderMetrics.js that changes how an EXISTING address or
 * metric is categorized must add a matching entry to
 * config/classification-changelog.json (see CLAUDE.md "Reclassification
 * changelog") before this script is re-run.
 *
 * Output: public/data/classification-changelog.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("sync-classification-changelog");

const CONFIG_PATH = path.resolve(process.cwd(), "config/classification-changelog.json");
const OUTPUT_PATH = path.resolve(process.cwd(), "public/data/classification-changelog.json");

const main = async () => {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  const events = Array.isArray(config?.events) ? config.events : [];

  const payload = {
    schemaVersion: config.schemaVersion ?? 1,
    generatedAt: new Date().toISOString(),
    source: { type: "static", configPath: "config/classification-changelog.json" },
    events,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH} (${events.length} events)`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
