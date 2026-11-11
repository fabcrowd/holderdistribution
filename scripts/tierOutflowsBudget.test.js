import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const MIN_MS = 60_000;

// A step killed by its timeout writes nothing, so a tier reset rescan that never
// finished inside the nightly step never converged. Every step that runs the tier
// scan must set TIER_OUTFLOWS_MAX_MS, and leave at least a minute before the
// step (or job) timeout to write the store and checkpoint.
const tierSteps = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith(".yml"))
  .flatMap((file) => {
    const doc = parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8"));
    return Object.entries(doc.jobs ?? {}).flatMap(([jobId, job]) =>
      (job.steps ?? [])
        .filter((step) => /generate-tier-outflows\.js/.test(step.run ?? ""))
        .map((step) => ({ file, jobId, step, timeoutMin: step["timeout-minutes"] ?? job["timeout-minutes"] })),
    );
  });

describe("tier-outflows time budget", () => {
  it("finds the nightly and standalone tier scans", () => {
    expect(tierSteps.map((s) => s.file).sort()).toEqual(expect.arrayContaining(["generate-tier-outflows.yml", "refresh-holders.yml"]));
  });

  for (const { file, jobId, step, timeoutMin } of tierSteps) {
    it(`${file} ${jobId} "${step.name}" stops before its timeout`, () => {
      const budget = Number(step.env?.TIER_OUTFLOWS_MAX_MS);
      expect(Number.isFinite(budget) && budget > 0, "TIER_OUTFLOWS_MAX_MS must be set").toBe(true);
      expect(Number(timeoutMin) > 0, "step or job needs timeout-minutes").toBe(true);
      expect(budget).toBeLessThanOrEqual(Number(timeoutMin) * 60_000 - MIN_MS);
    });
  }
});
