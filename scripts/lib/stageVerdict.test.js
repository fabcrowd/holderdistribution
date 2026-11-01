import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

/**
 * Guards the "Stage verdict" step of refresh-tel-holders.yml.
 *
 * Non-fatal stages (continue-on-error) cannot fail the run on their own, so a
 * crashed stage would otherwise stay green. The verdict step runs last and fails
 * the run when any listed stage failed. A new continue-on-error stage that is
 * not added to the verdict env would silently go unreported; these tests fail
 * instead.
 */
const WORKFLOW = path.resolve(process.cwd(), ".github/workflows/refresh-tel-holders.yml");

// covered by the fatal retry step
const EXEMPT = new Set(["holders_public"]);

const readSteps = () => {
  const doc = yaml.parse(fs.readFileSync(WORKFLOW, "utf8"));
  return doc.jobs.refresh.steps;
};

describe("Stage verdict guard", () => {
  it("has a Stage verdict step", () => {
    const steps = readSteps();
    expect(steps.find((s) => s.name === "Stage verdict")).toBeDefined();
  });

  it("every continue-on-error step has an id", () => {
    const steps = readSteps();
    for (const step of steps.filter((s) => s["continue-on-error"] === true)) {
      expect(typeof step.id, `step "${step.name}" needs an id`).toBe("string");
    }
  });

  it("lists every continue-on-error stage in the verdict env", () => {
    const steps = readSteps();
    const verdict = steps.find((s) => s.name === "Stage verdict");
    const coeIds = steps
      .filter((s) => s["continue-on-error"] === true && !EXEMPT.has(s.id))
      .map((s) => s.id);
    for (const id of coeIds) {
      expect(
        Object.values(verdict.env).some((v) => String(v).includes(`steps.${id}.outcome`)),
        `stage "${id}" is missing from the Stage verdict env`,
      ).toBe(true);
    }
  });

  it("runs with if: always()", () => {
    const verdict = readSteps().find((s) => s.name === "Stage verdict");
    expect(verdict.if).toBe("always()");
  });

  it("sits after the last continue-on-error step and before Notify on failure", () => {
    const steps = readSteps();
    const verdictIndex = steps.findIndex((s) => s.name === "Stage verdict");
    const notifyIndex = steps.findIndex((s) => s.name === "Notify on failure");
    expect(notifyIndex).toBeGreaterThan(-1);
    const lastCoeIndex = steps.reduce(
      (last, s, i) => (s["continue-on-error"] === true ? i : last),
      -1,
    );
    expect(verdictIndex).toBeGreaterThan(lastCoeIndex);
    expect(notifyIndex).toBeGreaterThan(verdictIndex);
  });

  it("Notify on failure passes FAILED_STAGES", () => {
    const notify = readSteps().find((s) => s.name === "Notify on failure");
    expect(notify.env.FAILED_STAGES).toBeDefined();
  });

  it("the exempt holders_public step is retried by a fatal step", () => {
    const steps = readSteps();
    const retry = steps.find(
      (s) =>
        String(s.if ?? "").includes("steps.holders_public.outcome") &&
        s["continue-on-error"] !== true,
    );
    expect(retry).toBeDefined();
  });
});
