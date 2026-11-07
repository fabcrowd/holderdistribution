#!/usr/bin/env node
/**
 * check-go-live.js
 *
 * Exits 1 unless every selected project is complete (scripts/lib/goLive.js).
 *
 *   node scripts/check-go-live.js --all
 *   node scripts/check-go-live.js --project <slug> [--section config|feeds|wallet-flows|ledger] [--alignment warn|strict|off]
 *
 * Alignment (shared day cutoffs + asOf, scripts/lib/feedAlignment.js): every
 * published feed carries asOf, settled end dates agree (live chains within 1
 * day), comparable blocks agree, and date-blocks.json has cutoffs for every
 * chain. The registry has no live/onboarding status, so the mode is a flag:
 * default "warn" (already-registered projects keep passing the nightly);
 * onboarding a new token runs --alignment strict, which fails on any problem.
 * HD_GO_LIVE_ALIGNMENT sets the default. Skipped when --section is given.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRegistry, resolveProject, projectChainEntries } from "./lib/projects.js";
import { goLiveProblems } from "./lib/goLive.js";
import { readCutoffMap } from "./lib/dayBlocks.js";
import { alignmentReport } from "./check-feed-alignment.js";

export const ALIGNMENT_MODES = Object.freeze(["warn", "strict", "off"]);

/** Every alignment reason `project` may not go live, each naming the feed/chain and the fix command. */
export function alignmentProblems(project, { root = process.cwd() } = {}) {
  const { slug } = project;
  const fix = {
    cutoffs: `node scripts/build-cutoffs.js --project ${slug} --from <first holders date>`,
    regen: `run the settled nightly or node scripts/fill-history-gaps.js --project ${slug}, then regenerate the feed`,
  };
  const problems = [];
  const [report] = alignmentReport({ root, only: slug, strict: true });
  for (const p of report?.result.problems ?? []) problems.push(`${slug}: alignment: ${p} (fix: ${fix.regen})`);
  const cutoffs = readCutoffMap(project, { root });
  for (const { key } of projectChainEntries(project.config)) {
    if (!Object.keys(cutoffs[key] ?? {}).length) {
      problems.push(`${slug}: alignment: date-blocks.json has no cutoffs for chain ${key} (fix: ${fix.cutoffs})`);
    }
  }
  return problems;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const slug = option("--project");
  const section = option("--section");
  const alignment = option("--alignment") ?? process.env.HD_GO_LIVE_ALIGNMENT ?? "warn";
  if ((!slug && !argv.includes("--all")) || !ALIGNMENT_MODES.includes(alignment)) {
    console.error("usage: check-go-live.js --all | --project <slug> [--section <name>] [--alignment warn|strict|off]");
    process.exit(2);
  }

  const slugs = slug ? [slug] : loadRegistry().map((project) => project.slug);
  let failed = false;
  for (const name of slugs) {
    const project = resolveProject(name);
    const problems = goLiveProblems(project, { section });
    const aligned = section || alignment === "off" ? [] : alignmentProblems(project);
    const fatal = alignment === "strict" ? [...problems, ...aligned] : problems;
    console.log(fatal.length === 0 ? `PASS ${name}` : `FAIL ${name} (${fatal.length})`);
    for (const problem of fatal) console.log(`  - ${problem}`);
    if (alignment === "warn") for (const warning of aligned) console.log(`  WARN ${warning}`);
    failed ||= fatal.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
