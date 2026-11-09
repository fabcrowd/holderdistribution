#!/usr/bin/env node
/**
 * write-pipeline-status.js
 *
 * Per-project nightly status file: <dataDir>/pipeline-status.json (TEL:
 * public/data/pipeline-status.json; others public/data/<slug>/pipeline-status.json).
 * One row per job in config/nightly-jobs.json: run / waived (reason) / n/a,
 * provider order, Alchemy budget, Alchemy CU recorded for the job's scripts on
 * the latest day in the project's rpc-usage.json (<workDir>/rpc-usage.json), and every output's age vs its
 * freshness SLA. Read-only on every feed; writes only the status file.
 *
 * Timestamps: the output's generatedAt / generated / updatedAt, else the last
 * commit touching the file (git), else "no-timestamp".
 *
 * Exit 1 with --check when any scheduled job is stale, missing or over budget
 * (pipeline-watchdog.yml files an issue from the --json report).
 *
 * Run: node scripts/write-pipeline-status.js [--project <slug> | --all] [--check] [--json] [--out-dir <dir>] [--no-write]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadRegistry, resolveProject, projectWorkDir } from "./lib/projects.js";
import { nightlyPlan, projectOutputPath } from "./lib/nightlyPlan.js";

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

export function outputTimestamp(absPath, root = process.cwd()) {
  const doc = readJson(absPath);
  for (const v of [doc?.generatedAt, doc?.generated, doc?.updatedAt, doc?.meta?.generatedAt]) {
    const t = Date.parse(v ?? "");
    if (Number.isFinite(t)) return { ms: t, source: "field" };
  }
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", path.relative(root, absPath)], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const t = Date.parse(out);
    if (Number.isFinite(t)) return { ms: t, source: "git" };
  } catch {
    /* not a git checkout */
  }
  return null;
}

/** Alchemy CU per script on the latest recorded day. */
export function latestUsage(root = process.cwd(), project = null) {
  const usage = readJson(path.resolve(root, project ? projectWorkDir(project) : "data", "rpc-usage.json"));
  const days = Object.keys(usage?.days ?? {}).sort();
  const day = days.at(-1);
  return { day: day ?? null, byScript: day ? usage.days[day].byScript ?? {} : {} };
}

export function projectStatus(slug, { root = process.cwd(), now = Date.now(), plan = nightlyPlan(root), usage } = {}) {
  const project = resolveProject(slug, root);
  usage ??= latestUsage(root, project);
  const entry = plan.projects.find((p) => p.slug === slug);
  const jobs = [];
  for (const job of plan.jobs) {
    const st = entry?.jobs.find((j) => j.id === job.id) ?? { status: "n/a", reason: entry?.error ?? "not planned" };
    const row = {
      id: job.id,
      workflow: job.workflow,
      status: st.status,
      reason: st.reason ?? null,
      providers: st.providers ?? job.providers,
      alchemyOnly: job.alchemyOnly === true,
      alchemyCuBudget: (st.providers ?? job.providers).includes("alchemy") ? Number(job.alchemyCuPerNight) || 0 : 0,
      budgetMode: (st.providers ?? job.providers).includes("alchemy") ? job.budgetMode ?? "enforce" : "enforce",
      health: st.status === "run" ? "ok" : st.status,
      outputs: [],
    };
    if (st.status === "run") {
      // rpc-usage.json is per script across projects; reported as the job's latest figure.
      // The Solana flow-scan Alchemy backup has its own monthly cap and no per-night job budget.
      const cu = (job.scripts ?? []).reduce((a, s) => a + (Number(usage.byScript?.[s]?.alchemyCu) || 0) - (Number(usage.byScript?.[s]?.solanaBackupCu) || 0), 0);
      row.alchemyCuLatest = { day: usage.day, cu };
      if (cu > row.alchemyCuBudget) row.health = "over-budget";
      for (const o of job.outputs ?? []) {
        const rel = projectOutputPath(project, o.path);
        const abs = path.resolve(root, rel);
        const exists = fs.existsSync(abs);
        const ts = exists ? outputTimestamp(abs, root) : null;
        const ageHours = ts ? Math.round(((now - ts.ms) / 3600000) * 10) / 10 : null;
        const status = !exists ? "missing" : ageHours == null ? "no-timestamp" : ageHours > o.maxAgeHours ? "stale" : "fresh";
        row.outputs.push({ path: rel, maxAgeHours: o.maxAgeHours, ageHours, generatedAt: ts ? new Date(ts.ms).toISOString() : null, status });
        if (status === "missing" || status === "stale") row.health = status;
      }
    }
    jobs.push(row);
  }
  const bad = jobs.filter((j) => ["missing", "stale", "over-budget"].includes(j.health));
  return {
    schemaVersion: 1,
    project: slug,
    generatedAt: new Date(now).toISOString(),
    healthy: bad.length === 0,
    problems: bad.map((j) => `${j.id}: ${j.health}`),
    jobs,
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const val = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = process.cwd();
  const one = val("--project") ?? process.env.HD_PROJECT;
  const slugs = argv.includes("--all") || !one ? loadRegistry(root).map((p) => p.slug) : [one];
  const plan = nightlyPlan(root);
  const reports = [];
  for (const slug of slugs) {
    const rep = projectStatus(slug, { root, plan });
    reports.push(rep);
    if (!argv.includes("--no-write")) {
      const project = resolveProject(slug, root);
      const dir = val("--out-dir") ? path.resolve(val("--out-dir"), slug) : path.resolve(root, project.dataDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pipeline-status.json"), `${JSON.stringify(rep, null, 2)}\n`);
    }
  }
  if (argv.includes("--json")) console.log(JSON.stringify({ reports }, null, 2));
  else for (const r of reports) console.log(`${r.project}: ${r.healthy ? "healthy" : r.problems.join("; ")}`);
  if (argv.includes("--check") && reports.some((r) => !r.healthy)) process.exit(1);
}
