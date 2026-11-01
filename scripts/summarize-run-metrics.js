#!/usr/bin/env node
/**
 * summarize-run-metrics.js [--project <slug>] [--metrics <file>]
 *
 * Folds this job's RPC usage lines (HD_METRICS_FILE, written by every pipeline
 * process through scripts/lib/rpcMetrics.js) into <work>/rpc-usage.json for the
 * selected project (daily totals, 62 days kept), then compares the month-to-date
 * totals of ALL registered projects with config/budgets.json.
 *
 * Output: a markdown table to $GITHUB_STEP_SUMMARY, ::warning:: at the warn
 * threshold, ::error:: and exit 1 on the run that first crosses the monthly
 * budget (later runs warn "still over budget"). Never prints RPC URLs or keys
 * (only provider classes and method names are counted).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { selectPipelineProject, projectWork, loadRegistry, resolveProject } from "./lib/projects.js";
import { aggregateRuns, evaluateBudget, mergeUsage, monthToDate, parseNdjson, renderSummary } from "./lib/runMetricsSummary.js";

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const readJson = async (p, fallback) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
};

const project = selectPipelineProject("summarize-run-metrics", { ported: true });
const metricsFile = argValue("--metrics") ?? process.env.HD_METRICS_FILE;
if (!metricsFile) {
  console.log("[summarize-run-metrics] HD_METRICS_FILE not set; nothing to summarize.");
  process.exit(0);
}

const lines = parseNdjson(await fs.readFile(metricsFile, "utf8").catch((err) => (err.code === "ENOENT" ? "" : Promise.reject(err))));
const agg = aggregateRuns(lines);
const date = new Date().toISOString().slice(0, 10);

const usagePath = projectWork(project)("rpc-usage.json");
const usage = mergeUsage(await readJson(usagePath, null), date, agg);
await fs.mkdir(path.dirname(usagePath), { recursive: true });
await fs.writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");

// Month-to-date across every registered project (their usage files are committed with the feeds).
const usages = [];
for (const { slug } of loadRegistry()) {
  const other = slug === project.slug ? usage : await readJson(projectWork(resolveProject(slug))("rpc-usage.json"), null);
  if (other) usages.push(other);
}
const budgets = await readJson(path.resolve("config/budgets.json"), {});
const evaluation = evaluateBudget(monthToDate(usages, date.slice(0, 7)), agg, budgets);

const markdown = renderSummary({ project: project.slug, date, agg, evaluation });
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
for (const m of evaluation.messages) console.log(`::${m.level === "fail" ? "error" : "warning"}::${m.text}`);
console.log(`Wrote ${usagePath}`);
if (evaluation.level === "fail") process.exit(1);
