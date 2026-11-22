import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

/**
 * Workflow-lint guard for sync-cex-wallets.yml.
 *
 * Each matrix job imports the free Dune spellbook CEX list for its own project
 * only (no paid Dune API, no DUNE_API_KEY). That step is non-fatal
 * (continue-on-error) and reports through the Stage verdict step, which fails
 * the run when it failed. The derived-feed re-apply runs only when the CEX config
 * changed. Slugs must come from scripts/workflow-paths.js, never from YAML.
 */
const WORKFLOW = path.resolve(process.cwd(), ".github/workflows/sync-cex-wallets.yml");
const REGISTRY = path.resolve(process.cwd(), "config/projects.json");

const readDoc = () => yaml.parse(fs.readFileSync(WORKFLOW, "utf8"));
const readSteps = () => readDoc().jobs.sync.steps;
const runOf = (step) => String(step?.run ?? "");
const stepIndex = (steps, pred) => steps.findIndex(pred);

describe("sync-cex-wallets.yml", () => {
  it("parses as YAML with a sync job", () => {
    expect(Array.isArray(readSteps())).toBe(true);
  });

  it("keeps the single-project workflow_dispatch input", () => {
    const inputs = readDoc().on.workflow_dispatch.inputs;
    expect(inputs.project).toBeDefined();
  });

  it("has a spellbook step with id spellbook and continue-on-error that imports only the job's own project", () => {
    const steps = readSteps();
    const spellbook = steps.find((s) => s.id === "spellbook");
    expect(spellbook, "spellbook step").toBeDefined();
    expect(spellbook["continue-on-error"]).toBe(true);
    expect(runOf(spellbook)).toMatch(/sync-cex-wallets-dune\.js --source spellbook --project "\$HD_PROJECT"/);
    expect(runOf(spellbook)).not.toMatch(/for slug in/);
    expect(runOf(spellbook)).not.toMatch(/SLUGS/);
    expect(JSON.stringify(spellbook.env ?? {})).not.toMatch(/SLUGS/);
  });

  it("leaves the mode to the script: the spellbook step picks no additions or candidates flag itself", () => {
    const spellbook = readSteps().find((s) => s.id === "spellbook");
    expect(runOf(spellbook)).not.toMatch(/HD_HAS_EVM/);
    expect(runOf(spellbook)).not.toMatch(/--candidates/);
    expect(runOf(spellbook)).not.toMatch(/\bargs\b/);
    expect(runOf(spellbook).trim()).toBe('node scripts/sync-cex-wallets-dune.js --source spellbook --project "$HD_PROJECT"');
  });

  it("does not use the paid Dune API: no dune_sync step, no DUNE_API_KEY, no --skip-if-no-query call", () => {
    const text = fs.readFileSync(WORKFLOW, "utf8");
    expect(text).not.toMatch(/DUNE_API_KEY/);
    expect(text).not.toMatch(/dune_sync|OUTCOME_DUNE_SYNC/);
    expect(readSteps().find((s) => s.id === "dune_sync")).toBeUndefined();
    expect(text).not.toMatch(/skip-if-no-query/);
    expect(readDoc().name).toMatch(/spellbook/i);
    expect(text).toMatch(/git commit -m "chore: sync CEX wallet list from Dune spellbook/);
  });

  it("gates the re-apply chain on a change to the project's CEX config", () => {
    const reapply = readSteps().find((s) => /Re-apply/.test(String(s.name)));
    expect(reapply, "re-apply step").toBeDefined();
    const run = runOf(reapply);
    expect(run).toMatch(/git status --porcelain[^\n]*"\$HD_CEX_CONFIG"/);
    expect(run).toMatch(/::notice::/);
    expect(run).toMatch(/exit 0/);
    // The gate comes before the first chain script.
    expect(run.indexOf("git status")).toBeLessThan(run.indexOf("resync-chain-holders.js"));
    expect(run).toMatch(/resync-chain-holders\.js/);
  });

  it("the re-apply chain does not append a treasury-history row (that is the nightly's daily append)", () => {
    const reapply = readSteps().find((s) => /Re-apply/.test(String(s.name)));
    // Strip comments: the explanation may name the script, the commands may not.
    const commands = runOf(reapply)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(commands).not.toMatch(/append-treasury-history/);
  });

  it("every continue-on-error step has an id", () => {
    const steps = readSteps();
    for (const step of steps.filter((s) => s["continue-on-error"] === true)) {
      expect(typeof step.id, `step "${step.name}" needs an id`).toBe("string");
    }
  });

  it("has a Stage verdict step that runs always and lists exactly the non-fatal steps (spellbook)", () => {
    const steps = readSteps();
    const verdict = steps.find((s) => s.name === "Stage verdict");
    expect(verdict, "Stage verdict step").toBeDefined();
    expect(verdict.if).toBe("always()");
    const coeIds = steps.filter((s) => s["continue-on-error"] === true).map((s) => s.id);
    expect(coeIds).toEqual(["spellbook"]);
    const outcomes = Object.values(verdict.env).map(String);
    expect(outcomes).toEqual(coeIds.map((id) => `\${{ steps.${id}.outcome }}`));
    const stageIds = [...runOf(verdict).matchAll(/^\s*(\w+)\|OUTCOME_\w+\|/gm)].map((m) => m[1]);
    expect(stageIds).toEqual(coeIds);
  });

  it("the Stage verdict sits after every continue-on-error step", () => {
    const steps = readSteps();
    const verdictIndex = stepIndex(steps, (s) => s.name === "Stage verdict");
    const lastCoeIndex = steps.reduce((last, s, i) => (s["continue-on-error"] === true ? i : last), -1);
    expect(verdictIndex).toBeGreaterThan(lastCoeIndex);
  });

  it("commit step stages only the job's own project paths via workflow-paths.js files", () => {
    const commit = readSteps().find((s) => s.id === "commit");
    expect(runOf(commit)).toMatch(/node scripts\/workflow-paths\.js files /);
    expect(runOf(commit)).toMatch(/git status --porcelain/);
    expect(runOf(commit)).not.toMatch(/for slug in/);
    expect(runOf(commit)).not.toMatch(/SLUGS/);
    expect(JSON.stringify(commit.env ?? {})).not.toMatch(/SLUGS/);
    expect(JSON.stringify(readSteps())).not.toMatch(/SLUGS/);
  });

  it("commit step has no autostash and guards against conflict markers before git commit", () => {
    const run = runOf(readSteps().find((s) => s.id === "commit"));
    expect(run).not.toMatch(/--autostash/);
    expect(run).not.toMatch(/git stash/);
    const guard = run.indexOf("git diff --cached");
    expect(guard, "marker guard on the staged diff").toBeGreaterThan(-1);
    expect(run).toContain("(<<<<<<<|=======|>>>>>>>)( |$)");
    expect(run.indexOf("git add")).toBeLessThan(guard);
    expect(guard).toBeLessThan(run.indexOf("git commit"));
    expect(run.slice(guard, run.indexOf("git commit"))).toMatch(/::error::[\s\S]*exit 1/);
  });

  it("commit step pushes through the retrying push-main.sh helper, after the commit", () => {
    const run = runOf(readSteps().find((s) => s.id === "commit"));
    expect(run).toMatch(/bash scripts\/push-main\.sh/);
    expect(run).not.toMatch(/git push/);
    expect(run.indexOf("git commit")).toBeLessThan(run.indexOf("push-main.sh"));
    const helper = fs.readFileSync(path.resolve(process.cwd(), "scripts/push-main.sh"), "utf8");
    expect(helper).toMatch(/MAX_ATTEMPTS=5/);
    expect(helper).toMatch(/git rebase --abort/);
  });

  it("no registry slug is written as a literal inside any run block", () => {
    const slugs = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).projects.map((p) => p.slug);
    const runs = readSteps().map(runOf).join("\n");
    for (const slug of slugs) {
      // A standalone token (--project tel, 'zebec-network'), not a substring of a file name like tel-holders.json.
      const token = new RegExp(`(^|[\\s'"=])${slug.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}($|[\\s'"])`, "m");
      expect(token.test(runs), `slug "${slug}" must not be a literal in a run block`).toBe(false);
    }
  });

  it("no workflow calls the Dune query API (every sync-cex-wallets-dune.js call is the free spellbook import)", () => {
    const dir = path.resolve(process.cwd(), ".github/workflows");
    const calls = fs
      .readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n").map((line) => ({ name, line })))
      .filter(({ line }) => line.includes("sync-cex-wallets-dune.js"));
    for (const { name, line } of calls) {
      expect(line, `${name}: only the spellbook source is allowed`).toMatch(/--source\s+spellbook/);
    }
  });
});
