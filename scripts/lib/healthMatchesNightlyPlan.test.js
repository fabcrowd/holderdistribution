import { describe, it, expect } from "vitest";
import { loadRegistry, loadProjectConfig } from "./projects.js";
import { projectRunsJob } from "./nightlyPlan.js";
import { resolveFeedHealth } from "./feedHealth.js";

// pipeline-health exits 1 for a monitored feed that no job produces, which the watchdog
// reads as a broken pipeline. A project that waives a nightly job must stop monitoring its feed.
describe("health feeds follow the nightly plan", () => {
  for (const { slug } of loadRegistry()) {
    it(`${slug}: monitors staker balances only when the nightly runs that job`, () => {
      const monitored = resolveFeedHealth(loadProjectConfig(slug)).some((feed) => feed.file === "funding-wallets.json");
      expect(monitored).toBe(projectRunsJob(slug, "staker-balances"));
    });
  }
});
