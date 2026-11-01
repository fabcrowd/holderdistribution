// Writes tasks/receipt.md: git facts plus recorded check results for the current working tree.
// Usage: npm run receipt -- --objective "text" [--verify]
// --verify runs typecheck, tests and feed checks; without it the receipt says they were not run.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReceipt, parseStatusPorcelain, summarizeOutput } from "./lib/changeReceipt.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "tasks", "receipt.md");
const VERIFY_STEPS = Object.freeze([
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "test", args: ["test"] },
  { name: "check:feeds", args: ["run", "check:feeds"] },
]);
const SUMMARY_CHARS = 160;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trimEnd();
}

function parseArgs(argv) {
  const objIndex = argv.indexOf("--objective");
  return {
    objective: objIndex >= 0 && argv[objIndex + 1] ? argv[objIndex + 1] : "(objective not given)",
    verify: argv.includes("--verify"),
  };
}

function runCheck(step) {
  const result = spawnSync("npm", step.args, { cwd: ROOT, encoding: "utf8", shell: true });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    name: step.name,
    ok: result.status === 0,
    summary: `exit ${result.status}: ${summarizeOutput(output).slice(0, SUMMARY_CHARS)}`,
  };
}

function gatherGitFacts() {
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(["rev-parse", "--short", "HEAD"]),
    changed: parseStatusPorcelain(git(["status", "--porcelain"])),
    diffStat: git(["diff", "--stat"]),
  };
}

function main() {
  const { objective, verify } = parseArgs(process.argv.slice(2));
  const facts = gatherGitFacts();
  const checks = verify ? VERIFY_STEPS.map(runCheck) : [];
  const receipt = buildReceipt({
    objective,
    ...facts,
    checks,
    generatedAt: new Date().toISOString(),
  });
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, receipt);
  process.stdout.write(`Wrote ${OUT_PATH}\n`);
}

main();
