#!/usr/bin/env node
/**
 * pipeline-health.js
 *
 * Standing health check for the data pipeline, designed to be run from OUTSIDE
 * GitHub Actions — by a human, or by a Claude Code session on a schedule.
 *
 * WHY THIS CANNOT LIVE INSIDE A GITHUB ACTIONS WORKFLOW
 *
 * The failure mode that actually happened (2026-08-29) was an account-level
 * Actions block: every workflow failed in 3-5 seconds with no job logs,
 * INCLUDING workflows that touch no chain data. A watchdog workflow added to
 * this same repo would be blocked by the same gate it exists to detect — it
 * would never run either. Detection has to live somewhere Actions being down
 * cannot silence, which means outside Actions entirely. This script is built
 * to be that: it only reads files already in the repo (via `git pull`) or
 * already served (via HTTPS), needs no RPC credentials, and takes under a
 * second.
 *
 * WHAT "healthy" MEANS
 *
 * Ground truth is DATA FRESHNESS, not workflow run status. A workflow can
 * succeed and still write stale or wrong data (see check-feed-consistency.js);
 * a workflow can fail for a reason that doesn't matter (a transient RPC
 * timeout the next scheduled run absorbs). Checking `generatedAt` against a
 * per-feed threshold answers the only question that matters to a reader of
 * the site: is what's on screen current.
 *
 * Thresholds are wider than the cron period so a single missed run doesn't
 * page. `refresh-tel-holders` runs daily → 36h. `scan-exchange-flows` and
 * `generate-tier-outflows` are chained after it via workflow_run, and
 * tier-outflows in particular is allowed to run behind during a legitimate
 * incremental backfill (see generate-tier-outflows.js's own `complete` flag),
 * so it gets a 4-day allowance rather than paging on ordinary catch-up lag.
 * `sync-cex-wallets` is biweekly → 20 days.
 *
 * PROJECTS
 *
 * Registry-driven: every project in config/projects.json is held to the
 * default feed table in scripts/lib/feedHealth.js, overridable per project via
 * its config `health.feeds` block (maxAgeHours, placeholder, disabled). A
 * `placeholder` feed (an intentional stub, e.g. a flow scanner not built for
 * that chain yet) is reported as PLACEHOLDER and never counts as stale.
 *
 * OUTPUT CONTRACT
 *
 * Exit 0 = healthy. Exit 1 = at least one non-placeholder feed of any checked
 * project exceeded its threshold, and the printed report includes the EXACT
 * next commands to run locally — see
 * README → "When the scheduled workflows are down". This is deliberate: the
 * output of this script is written to be pasted directly into a Claude Code
 * session as the instruction for what to do next, since that is the actual
 * delivery path (see "note to run it in this environment" in README).
 *
 * Run: node scripts/pipeline-health.js [--project <slug> | --all] [--json]
 *   no flag / --all   every registered project
 *   --project <slug>  one project (--json keeps the single-project shape)
 */
import process from "node:process";
import { loadRegistry, resolveProject } from "./lib/projects.js";
import { evaluateAllProjects, fallbackFor, isUnhealthy } from "./lib/feedHealth.js";

const HOUR = 3_600_000;
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");

/** `--project slug` / `--project=slug` -> slug, else null (= all projects). `--all` wins. */
const requestedSlug = () => {
  if (argv.includes("--all")) return null;
  const i = argv.findIndex((a) => a === "--project" || a.startsWith("--project="));
  if (i === -1) return null;
  const slug = argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  if (!slug || slug.startsWith("--")) throw new Error("--project needs a slug, e.g. --project tel");
  return slug.trim().toLowerCase();
};

const printProject = (p, heading) => {
  if (heading) console.log(heading);
  if (p.error) {
    console.log(`  ERROR  ${p.error}`);
    return;
  }
  for (const r of p.results) {
    const ageStr = r.ageMs != null ? `${(r.ageMs / HOUR).toFixed(1)}h old (limit ${(r.thresholdMs / HOUR).toFixed(0)}h)` : "";
    const mark = r.status === "healthy" ? "ok  " : r.status === "stale" ? "STALE" : r.status.toUpperCase();
    console.log(`  ${mark.padEnd(6)} ${r.label.padEnd(38)} ${ageStr}`);
  }

  const gaps = p.gaps;
  if (!gaps) return;
  const mark = gaps.missing.length === 0 ? "ok  " : "GAP";
  console.log(
    `  ${mark.padEnd(6)} ${`Daily coverage (last ${gaps.windowDays}d)`.padEnd(38)} ` +
      `${gaps.missing.length} missing date(s)`,
  );
  if (gaps.missing.length) {
    console.log(`         missing: ${gaps.missing.join(", ")}`);
    console.log('         fix: node scripts/fill-history-gaps.js   (workflow: "Fill holders-history gaps")');
  }
  if (gaps.known?.length) {
    console.log(`         known gap (declared unfillable): ${gaps.known.join(", ")}`);
  }
  if (gaps.withoutCumulative.length) {
    console.log(
      `         ${gaps.withoutCumulative.length} row(s) await a continuous recompute for ` +
        `cumulativeHolders (workflow: "Rebuild holders history from Transfer logs")`,
    );
  }
};

const printRecovery = (projects) => {
  const broken = projects.filter((p) => !p.healthy);
  const unhealthyCount = broken.reduce((n, p) => n + p.results.filter(isUnhealthy).length, 0);
  console.log(`\n${unhealthyCount} feed(s) exceeded their freshness threshold${broken.some((p) => p.error) ? " (plus config errors above)" : ""}.`);
  console.log("This means the scheduled GitHub Actions workflows are not landing — check");
  console.log("Actions → recent runs for the workflow(s) named below. If runs are failing in");
  console.log("3-5 seconds with no logs across UNRELATED workflows too, that is an");
  console.log("account-level block (billing/spending limit), not a script bug — tell the user");
  console.log("directly rather than debugging the scripts.\n");
  console.log("Run the fallback for each stale feed, IN THIS ENVIRONMENT, in this order:\n");

  for (const p of broken.filter((b) => !b.error)) {
    const project = resolveProject(p.slug);
    for (const r of p.results.filter(isUnhealthy)) {
      const tag = projects.length > 1 ? `[${p.slug}] ` : "";
      console.log(`--- ${tag}${r.label} (workflow: "${r.workflow}") ---`);
      for (const line of fallbackFor(r, project)) console.log(`  ${line}`);
      console.log();
    }
  }

  console.log("After running any fallback: git add the changed public/data/**, commit, and");
  console.log("push straight to main (per CLAUDE.md — no PR needed). Netlify deploys on push.");
};

const main = () => {
  let report;
  let slug;
  const now = Date.now();
  try {
    slug = requestedSlug();
    report = evaluateAllProjects({ now, slugs: slug ? [slug] : undefined });
  } catch (error) {
    console.error(`[pipeline-health] ${error.message}`);
    process.exit(2);
  }
  const generatedAt = new Date(now).toISOString();

  if (asJson) {
    // One project: the original shape (the watchdog's self-heal reads `results`/`gaps`).
    const out = slug
      ? { generatedAt, project: slug, results: report.projects[0].results, gaps: report.projects[0].gaps, healthy: report.healthy }
      : { generatedAt, projects: report.projects, healthy: report.healthy };
    console.log(JSON.stringify(out, null, 2));
    process.exit(report.healthy ? 0 : 1);
  }

  console.log(`Pipeline health check — ${generatedAt}\n`);
  const multi = report.projects.length > 1;
  const registry = loadRegistry();
  for (const p of report.projects) {
    const name = registry.find((r) => r.slug === p.slug)?.name ?? p.slug;
    printProject(p, multi ? `== ${p.slug} (${name}) ==` : null);
    if (multi) console.log();
  }

  if (report.healthy) {
    console.log(multi ? "All feeds within threshold for every project. Nothing to do." : "\nAll feeds within threshold. Nothing to do.");
    process.exit(0);
  }

  printRecovery(report.projects);
  process.exit(1);
};

main();
