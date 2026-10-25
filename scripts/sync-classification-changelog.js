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
import { selectPipelineProject, projectPaths, projectClassificationPath } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: TEL copies
// config/classification-changelog.json -> public/data/; another project copies
// its own `classification.changelog` -> public/data/<slug>/ (none declared =
// an empty events[] feed in the same format, never TEL's events).
const project = selectPipelineProject("sync-classification-changelog", { ported: true });

const ROOT = process.cwd();
const CONFIG_PATH = projectClassificationPath(project, "changelog", ROOT);
const OUTPUT_PATH = projectPaths(project, ROOT)("classification-changelog.json");

const main = async () => {
  const config = CONFIG_PATH ? JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) : {};
  const events = Array.isArray(config?.events) ? config.events : [];

  const payload = {
    schemaVersion: config.schemaVersion ?? 1,
    generatedAt: new Date().toISOString(),
    source: { type: "static", configPath: CONFIG_PATH ? path.relative(ROOT, CONFIG_PATH).split(path.sep).join("/") : null },
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
