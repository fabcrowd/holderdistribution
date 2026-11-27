import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

// 2026-11-27 (run 45975348118): the staker step was pinned to the Alchemy keys with
// RPC_PREFER_PUBLIC=0, ran out of its 1,000 CU budget and failed without trying a
// free endpoint. Every place that runs pull-staker-balances.js now follows the job's
// provider order in config/nightly-jobs.json (public first, keys in reserve).
const read = (f) => fs.readFileSync(path.resolve(process.cwd(), f), "utf8");
const steps = (file) => Object.values(yaml.parse(read(file)).jobs).flatMap((j) => j.steps ?? []);
const stakerSteps = (file) => steps(file).filter((s) => /node scripts\/pull-staker-balances\.js/.test(String(s.run ?? "")));

describe("staker-balances provider order", () => {
  it("config: the job lists public before alchemy and enforces its Alchemy budget", () => {
    const job = JSON.parse(read("config/nightly-jobs.json")).jobs.find((j) => j.id === "staker-balances");
    expect(job.providers.indexOf("public")).toBeGreaterThanOrEqual(0);
    expect(job.providers.indexOf("public")).toBeLessThan(job.providers.indexOf("alchemy"));
    expect(job.budgetMode).toBe("enforce");
    expect(job.alchemyOnly).toBe(false);
  });

  for (const file of [".github/workflows/refresh-holders.yml", ".github/workflows/refresh-staker-balances.yml"]) {
    it(`${path.basename(file)}: the staker step runs as job staker-balances with no RPC_PREFER_PUBLIC pin`, () => {
      const found = stakerSteps(file);
      expect(found.length).toBeGreaterThan(0);
      for (const step of found) {
        expect(step.env?.HD_JOB_ID).toMatch(/^staker-balances\b/);
        expect(step.env).not.toHaveProperty("RPC_PREFER_PUBLIC");
      }
    });
  }

  it("pipeline-watchdog.yml: the self-heal runs the staker script without pinning the keys", () => {
    const lines = read(".github/workflows/pipeline-watchdog.yml").split("\n").filter((l) => l.includes("pull-staker-balances.js") && l.includes("node "));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/HD_JOB_ID=staker-balances/);
      expect(line).not.toMatch(/RPC_PREFER_PUBLIC/);
    }
  });
});
