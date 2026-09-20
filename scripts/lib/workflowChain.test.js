import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

/**
 * Guards the data-pipeline workflow chain.
 *
 * The three data workflows run in a strict order enforced by `workflow_run`:
 *
 *   Refresh TEL holders snapshot  ->  Scan exchange flows  ->  Generate tier outflows
 *
 * `workflow_run` matches the upstream workflow by its `name:` STRING. Renaming
 * an upstream workflow therefore breaks the chain silently — GitHub does not
 * warn, the downstream workflow simply stops being triggered, and the only
 * symptom is a feed quietly going stale. These tests fail instead.
 */
const DIR = path.resolve(process.cwd(), ".github/workflows");

/**
 * Parses a workflow, restoring triggers that are commented out by a pause.
 *
 * Feeds were paused on 2026-09-13 (Netlify build credits exhausted) by
 * commenting out `schedule:` and `workflow_run:` and leaving
 * `workflow_dispatch` live. Read literally, that makes every assertion here
 * pass vacuously or fail for the wrong reason: the chain is not "broken", it is
 * switched off, and the guard still needs to hold for the configuration a
 * resume restores. So inside the `on:` block a commented line is uncommented
 * before parsing — the tests then check the wiring that will be live again,
 * which is the thing worth protecting.
 */
const load = (file) => {
  const raw = fs.readFileSync(path.join(DIR, file), "utf8");
  if (!raw.includes("PAUSED 2026-09-13")) return yaml.parse(raw);
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.startsWith("on:"));
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(" ") || lines[end].startsWith("#") || lines[end] === "")) end += 1;
  const restored = lines.map((line, i) =>
    i > start && i < end && /^#\s/.test(line) ? line.replace(/^#\s?/, "") : line,
  );
  return yaml.parse(restored.join("\n"));
};
/** `on:` is parsed as the boolean key `true` by YAML 1.1 semantics in some parsers. */
const triggers = (doc) => doc.on ?? doc[true] ?? {};

const workflowNames = () =>
  new Set(
    fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => load(f)?.name)
      .filter(Boolean),
  );

const CHAIN = [
  { file: "scan-exchange-flows.yml", dependsOn: "Refresh TEL holders snapshot" },
  { file: "generate-tier-outflows.yml", dependsOn: "Scan exchange flows" },
];

describe("data pipeline workflow chain", () => {
  it("every workflow_run dependency names a workflow that exists", () => {
    const names = workflowNames();
    for (const { file, dependsOn } of CHAIN) {
      const refs = triggers(load(file))?.workflow_run?.workflows ?? [];
      expect(refs, `${file} lost its workflow_run trigger`).toContain(dependsOn);
      expect(
        names,
        `${file} depends on a workflow named "${dependsOn}", which no workflow declares — ` +
          `the chain is broken and the downstream feed will silently stop updating`,
      ).toContain(dependsOn);
    }
  });

  it("chained workflows skip when the upstream run did not succeed", () => {
    for (const { file } of CHAIN) {
      const job = Object.values(load(file).jobs)[0];
      expect(job.if, `${file}'s job needs an if: guard on workflow_run conclusion`).toBeTruthy();
      expect(job.if).toContain("workflow_run.conclusion");
      expect(job.if).toContain("success");
    }
  });

  it("chained workflows check out main, not the triggering commit", () => {
    // workflow_run checks out the SHA that triggered the UPSTREAM run, which
    // predates the data commit that run just made. Without `ref: main` the
    // downstream job scans against the previous classification.
    for (const { file } of CHAIN) {
      const steps = Object.values(load(file).jobs)[0].steps;
      const checkout = steps.find((s) => String(s.uses ?? "").startsWith("actions/checkout"));
      expect(checkout, `${file} has no checkout step`).toBeTruthy();
      expect(checkout.with?.ref, `${file}'s checkout must pin ref: main`).toBe("main");
    }
  });

  it("keeps a fallback schedule so a broken chain cannot freeze a feed forever", () => {
    for (const { file } of CHAIN) {
      expect(triggers(load(file)).schedule, `${file} needs a safety-net cron`).toBeTruthy();
    }
  });

  it("the daily workflow gates on cross-feed consistency before committing", () => {
    const doc = load("refresh-tel-holders.yml");
    const steps = doc.jobs.refresh.steps;
    const runs = steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("check-feed-consistency.js");
    expect(runs).toContain("sync-classification-changelog.js");

    const gateIdx = steps.findIndex((s) => (s.run ?? "").includes("check-feed-consistency.js"));
    const commitIdx = steps.findIndex((s) => (s.run ?? "").includes("git add"));
    expect(gateIdx, "consistency gate must run BEFORE the commit step").toBeLessThan(commitIdx);
  });
});
