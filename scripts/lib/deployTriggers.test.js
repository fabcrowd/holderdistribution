import { describe, it, expect } from "vitest";
import { readWorkflows, deployBudget, runsPerDay } from "./deployTriggers.js";

/**
 * The deploy-frequency contract, enforced rather than asserted in a commit
 * message.
 *
 * Netlify builds every commit pushed to `main` unless the message carries
 * `[skip netlify]`. On 2026-09-13 that was costing 7-12 builds a day — each
 * scan in the holders chain fired twice (a `workflow_run` chain AND its own
 * cron) and committed both times — which exhausted the site's build credits.
 * Nothing in the repo would have caught it; these tests are that check.
 */
describe("deploy frequency", () => {
  it("counts cron firings per day, ignoring weekly and monthly schedules", () => {
    expect(runsPerDay("0 0 * * *")).toBe(1);
    expect(runsPerDay("23 */6 * * *")).toBe(4);
    expect(runsPerDay("0 */4 * * *")).toBe(6);
    // Not a daily cost: real builds, but not every day.
    expect(runsPerDay("0 2 * * 0")).toBe(0);
    expect(runsPerDay("0 1 1,15 * *")).toBe(0);
  });

  it("schedules at most ONE unconditional publishing run per day", () => {
    const budget = deployBudget();
    expect(
      budget.perDay,
      `${budget.perDay} scheduled publishing runs/day. The contract is one: every extra one ` +
        `is a production build for data that only needs publishing once. Offenders: ` +
        budget.unconditional.map((w) => `${w.name} (${w.scheduled}/day)`).join(", "),
    ).toBeLessThanOrEqual(1);
  });

  it("keeps a publisher, so data actually reaches production", () => {
    // The mirror of the test above: driving deploys to zero would also satisfy
    // "at most one", and would mean nothing ever goes live — which is the
    // failure this repo has already had (build.ignore froze production twice).
    const workflows = readWorkflows();
    const publishers = workflows.filter((w) => w.publishes && (w.scheduled > 0 || w.chained));
    expect(
      publishers.length,
      "no scheduled workflow publishes: data would be committed but never deployed",
    ).toBeGreaterThan(0);
  });

  it("marks every recurring non-publishing writer with [skip netlify]", () => {
    const recurring = readWorkflows().filter((w) => w.scheduled > 0 || w.chained);
    const publishing = recurring.filter((w) => w.publishes && !w.conditional);
    expect(
      publishing.map((w) => w.name).sort(),
      "exactly one recurring workflow should publish unconditionally — the daily refresh",
    ).toEqual(["refresh-tel-holders"]);
  });
});
