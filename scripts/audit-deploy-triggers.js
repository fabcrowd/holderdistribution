#!/usr/bin/env node
/**
 * audit-deploy-triggers.js
 *
 * Prints how many production builds a normal day triggers, and fails under
 * --strict if that is more than one. The logic lives in lib/deployTriggers.js
 * so scripts/lib/deployTriggers.test.js enforces the same contract in CI —
 * a workflow that would reintroduce a second daily build breaks the suite
 * rather than quietly costing build credits.
 *
 * Run: node scripts/audit-deploy-triggers.js [--strict]
 */
import process from "node:process";
import { readWorkflows, deployBudget } from "./lib/deployTriggers.js";

const workflows = readWorkflows();
const budget = deployBudget(workflows);

console.log(`${"WORKFLOW".padEnd(30)} ${"RUNS/DAY".padEnd(9)} ${"PUBLISHES".padEnd(13)} STATE`);
for (const w of workflows) {
  const runs = w.scheduled ? String(w.scheduled) : w.infrequent ? "weekly+" : w.chained ? "chained" : "manual";
  const pub = w.publishes ? (w.conditional && w.scheduled > 0 ? "only if stale" : "YES") : "no (skip)";
  console.log(`${w.name.padEnd(30)} ${runs.padEnd(9)} ${pub.padEnd(13)} ${w.paused ? "paused" : "active"}`);
}

console.log(`\nBuilds on a normal day: ${budget.perDay}` +
  (budget.standby.length ? ` (plus ${budget.standby.map((w) => w.name).join(", ")} only when healing a stale feed)` : ""));
if (budget.allPaused) console.log("All scheduled writers are paused — no automatic builds at all right now.");

if (process.argv.includes("--strict") && budget.perDay > 1) {
  console.error(`\nFAIL: ${budget.perDay} scheduled publishing runs/day; the contract is one.` +
    ` Offenders: ${budget.unconditional.map((w) => `${w.name} (${w.scheduled}/day)`).join(", ")}`);
  process.exit(1);
}
