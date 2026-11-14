#!/usr/bin/env node
/**
 * onboard-check.js — the local gates for an onboarded project in one command.
 *
 *   npm run onboard:check -- --project <slug> [--skip-tests]
 *
 * Runs vitest, typecheck, lint, check-feed-consistency --strict, pipeline-health
 * and check-go-live --alignment strict strictly one after another, streams each
 * gate's output to tasks/onboard-check-<slug>-<gate>.log (gitignored), prints a
 * PASS/FAIL table with the log path, exits 1 if any gate failed. --skip-tests
 * drops vitest, typecheck and lint for a quick data-only pass.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { gatePlan, logPathFor, summarize } from "./lib/onboardCheck.js";
import { SLUG_RE } from "./lib/projects.js";

const argv = process.argv.slice(2);
const slugAt = argv.indexOf("--project");
const slug = slugAt >= 0 ? argv[slugAt + 1] : undefined;
if (!slug || !SLUG_RE.test(slug)) {
  console.error("--project <slug> is required (lower-case letters, digits, dashes).\nFix: npm run onboard:check -- --project <slug> [--skip-tests]");
  process.exit(2);
}

fs.mkdirSync("tasks", { recursive: true });
const results = [];
for (const gate of gatePlan({ slug, skipTests: argv.includes("--skip-tests") })) {
  const log = logPathFor(slug, gate.id);
  const fd = fs.openSync(path.resolve(log), "w");
  console.log(`running ${gate.id} ...`);
  // shell: true so npm/npx resolve their .cmd shims on Windows; the args are fixed strings plus a validated slug.
  const run = spawnSync([gate.cmd, ...gate.args].join(" "), { shell: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  results.push({ id: gate.id, status: run.status, log });
}
const { exitCode, text } = summarize(results);
console.log(`\n${text}`);
process.exit(exitCode);
