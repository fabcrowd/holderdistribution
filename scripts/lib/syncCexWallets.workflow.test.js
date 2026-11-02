import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

/**
 * Workflow-lint guard for sync-cex-wallets.yml.
 *
 * The Dune spellbook sync runs for every registry project (matrix all) before
 * the single-project Dune sync. Both sync steps are non-fatal (continue-on-error)
 * and report through the Stage verdict step, which fails the run when one of
 * them failed. Slugs must come from scripts/workflow-paths.js, never from YAML.
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

  it("has a spellbook step with id spellbook, continue-on-error, that loops the matrix", () => {
    const steps = readSteps();
    const spellbook = steps.find((s) => s.id === "spellbook");
    expect(spellbook, "spellbook step").toBeDefined();
    expect(spellbook["continue-on-error"]).toBe(true);
    expect(runOf(spellbook)).toMatch(/sync-cex-wallets-dune\.js --source spellbook --project "\$slug"/);
    expect(runOf(spellbook)).toMatch(/for slug in/);
    expect(runOf(spellbook)).toMatch(/SLUGS/);
    expect(spellbook.env.SLUGS).toMatch(/steps\.projects\.outputs\.slugs/);
    expect(readSteps().find((s) => s.id === "projects"), "projects step").toBeDefined();
  });

  it("gates the spellbook pass on config (HD_HAS_EVM), not on a slug check", () => {
    const spellbook = readSteps().find((s) => s.id === "spellbook");
    expect(runOf(spellbook)).toMatch(/HD_HAS_EVM=true/);
    expect(runOf(spellbook)).toMatch(/--candidates/);
  });

  it("the single-project Dune step has id dune_sync and is continue-on-error", () => {
    const dune = readSteps().find((s) => s.id === "dune_sync");
    expect(dune, "dune_sync step").toBeDefined();
    expect(dune["continue-on-error"]).toBe(true);
    expect(runOf(dune)).toMatch(/node scripts\/sync-cex-wallets-dune\.js\s*$/m);
  });

  it("runs the spellbook pass before the Dune sync", () => {
    const steps = readSteps();
    const spellbookIndex = stepIndex(steps, (s) => s.id === "spellbook");
    const duneIndex = stepIndex(steps, (s) => s.id === "dune_sync");
    expect(spellbookIndex).toBeGreaterThan(-1);
    expect(duneIndex).toBeGreaterThan(spellbookIndex);
  });

  it("every continue-on-error step has an id", () => {
    const steps = readSteps();
    for (const step of steps.filter((s) => s["continue-on-error"] === true)) {
      expect(typeof step.id, `step "${step.name}" needs an id`).toBe("string");
    }
  });

  it("has a Stage verdict step that runs always and lists spellbook and dune_sync", () => {
    const steps = readSteps();
    const verdict = steps.find((s) => s.name === "Stage verdict");
    expect(verdict, "Stage verdict step").toBeDefined();
    expect(verdict.if).toBe("always()");
    const envValues = Object.values(verdict.env).map(String);
    expect(envValues.some((v) => v.includes("steps.spellbook.outcome"))).toBe(true);
    expect(envValues.some((v) => v.includes("steps.dune_sync.outcome"))).toBe(true);
  });

  it("the Stage verdict sits after every continue-on-error step", () => {
    const steps = readSteps();
    const verdictIndex = stepIndex(steps, (s) => s.name === "Stage verdict");
    const lastCoeIndex = steps.reduce((last, s, i) => (s["continue-on-error"] === true ? i : last), -1);
    expect(verdictIndex).toBeGreaterThan(lastCoeIndex);
  });

  it("commit step stages every project's paths via workflow-paths.js files --project", () => {
    const commit = readSteps().find((s) => s.id === "commit");
    expect(runOf(commit)).toMatch(/HD_PROJECT="\$slug" node scripts\/workflow-paths\.js files /);
    expect(runOf(commit)).toMatch(/git status --porcelain/);
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
});
