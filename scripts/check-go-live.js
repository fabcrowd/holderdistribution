#!/usr/bin/env node
/**
 * check-go-live.js
 *
 * Exits 1 unless every selected project is complete (scripts/lib/goLive.js).
 *
 *   node scripts/check-go-live.js --all
 *   node scripts/check-go-live.js --project <slug> [--section config|feeds|wallet-flows|ledger]
 */
import { loadRegistry, resolveProject } from "./lib/projects.js";
import { goLiveProblems } from "./lib/goLive.js";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const slug = option("--project");
if (!slug && !argv.includes("--all")) {
  console.error("usage: check-go-live.js --all | --project <slug> [--section <name>]");
  process.exit(2);
}

const slugs = slug ? [slug] : loadRegistry().map((project) => project.slug);
let failed = false;
for (const name of slugs) {
  const problems = goLiveProblems(resolveProject(name), { section: option("--section") });
  console.log(problems.length === 0 ? `PASS ${name}` : `FAIL ${name} (${problems.length})`);
  for (const problem of problems) console.log(`  - ${problem}`);
  failed ||= problems.length > 0;
}
process.exit(failed ? 1 : 0);
