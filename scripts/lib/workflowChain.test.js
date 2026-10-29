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

/**
 * Since 2026-10-19 the chain is ONE scheduled job (refresh-tel-holders.yml)
 * running the stages as ordered steps, instead of three workflows linked by
 * workflow_run plus a fallback cron each. These guard that consolidation: the
 * order, and that no former stage quietly regains its own schedule (each one
 * was a second billed run every day on a minutes-capped plan).
 */
const FORMER_STAGES = ["scan-exchange-flows.yml", "generate-tier-outflows.yml", "fill-history-gaps.yml"];
const dailyCrons = (doc) =>
  (triggers(doc).schedule ?? []).filter(({ cron }) => {
    const [, , dom, , dow] = cron.trim().split(/\s+/);
    return dom === "*" && (dow === "*" || dow === undefined);
  });

/**
 * The watchdog runs daily (2026-10-28) so a dead feed or an Actions billing block is
 * caught within a day, not a week. It is a monitor: the heavy self-heal chain and
 * its (publishing) commit only run when a feed is actually stale.
 */
const DAILY_MONITORS = ["pipeline-watchdog.yml"];

describe("data pipeline workflow chain", () => {
  it("only the consolidated daily workflow (plus the watchdog monitor) runs on a daily schedule", () => {
    const daily = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".yml"))
      .filter((f) => dailyCrons(load(f)).length > 0);
    expect(daily.sort()).toEqual(["refresh-tel-holders.yml", ...DAILY_MONITORS].sort());
    expect(dailyCrons(load("refresh-tel-holders.yml"))).toHaveLength(1);
  });

  it("no per-project refresh workflow exists: onboarding a token is config only", () => {
    expect(fs.existsSync(path.join(DIR, "refresh-zebec-network.yml"))).toBe(false);
    const files = fs.readdirSync(DIR).filter((f) => /^refresh-.*\.yml$/.test(f));
    // Only the registry-driven refresh and the manual staker tool; a refresh-<slug>.yml would double-run.
    expect(files.sort()).toEqual(["refresh-staker-balances.yml", "refresh-tel-holders.yml", "refresh-wallet-flows.yml"]);
  });

  describe("registry-driven matrix", () => {
    const doc = load("refresh-tel-holders.yml");
    const matrix = doc.jobs.refresh.strategy;

    it("plan job feeds a one-at-a-time, fail-soft matrix from config/projects.json", () => {
      expect(doc.jobs.refresh.needs).toBe("plan");
      expect(matrix["max-parallel"]).toBe(1);
      expect(matrix["fail-fast"]).toBe(false);
      expect(matrix.matrix).toContain("fromJSON(needs.plan.outputs.matrix)");
      const planRuns = doc.jobs.plan.steps.map((s) => s.run ?? "").join("\n");
      expect(planRuns).toContain("workflow-paths.js matrix");
      expect(doc.jobs.refresh.env.HD_PROJECT).toBe("${{ matrix.slug }}");
      expect(doc.jobs.refresh["timeout-minutes"]).toBe("${{ matrix.timeout }}");
      expect(doc.jobs.plan["timeout-minutes"]).toBeGreaterThan(0);
    });

    it("keeps the dispatch project input (default all), the shared concurrency group, and no slug checks", () => {
      expect(triggers(doc).workflow_dispatch.inputs.project.default).toBe("all");
      expect(doc.concurrency).toEqual({ group: "holders-refresh", "cancel-in-progress": false });
      const src = fs.readFileSync(path.join(DIR, "refresh-tel-holders.yml"), "utf8");
      expect(src).not.toMatch(/matrix\.slug\s*==|HD_PROJECT\s*==|slug\s*==\s*'/);
    });

    it("passes every secret the two retired workflows passed", () => {
      const src = fs.readFileSync(path.join(DIR, "refresh-tel-holders.yml"), "utf8");
      for (const secret of ["ENV_PASSPHRASE", "SOLANA_RPC_0", "ETHERSCAN_API_KEY"]) {
        expect(src).toContain(`secrets.${secret}`);
      }
    });

    it("stages a project-dependent commit tag, verify list and gap fill from config", () => {
      const steps = doc.jobs.refresh.steps;
      const runs = steps.map((s) => s.run ?? "").join("\n");
      expect(runs).toContain("${HD_COMMIT_TAG}");
      expect(runs).toContain("$HD_REQUIRED_FILES");
      expect(runs).toContain("bash scripts/push-main.sh");
      expect(runs).not.toMatch(/git (fetch|rebase|push) origin/);
      expect(steps.find((s) => (s.run ?? "").includes("fill-history-gaps.js")).if).toContain("HD_HAS_EVM");
      const staking = steps.filter((s) => /^node scripts\/pull-(staker-balances|solana-staking)\.js$/.test((s.run ?? "").trim()));
      expect(staking).toHaveLength(2);
      for (const s of staking) expect(s["continue-on-error"]).toBe(true);
      const gateIdx = steps.findIndex((s) => (s.run ?? "").includes("check-feed-consistency.js"));
      const commitIdx = steps.findIndex((s) => (s.run ?? "").includes("git add"));
      expect(gateIdx).toBeLessThan(commitIdx);
    });
  });

  it("the watchdog's billing-block detection inspects individual jobs (a matrix run has several)", () => {
    const wd = fs.readFileSync(path.join(DIR, "pipeline-watchdog.yml"), "utf8");
    expect(wd).toContain("jobs.jobs.some");
    expect(wd).toContain("startup_failure");
  });

  it("former chained stages are manual-only (no cron, no workflow_run)", () => {
    for (const file of FORMER_STAGES) {
      const on = triggers(load(file));
      expect(on.schedule, `${file} regained a schedule`).toBeFalsy();
      expect(on.workflow_run, `${file} regained a workflow_run chain`).toBeFalsy();
      expect(on).toHaveProperty("workflow_dispatch");
    }
  });

  it("runs holders -> commit -> exchange flows -> tier outflows -> gaps -> gate -> commit, in order", () => {
    const steps = load("refresh-tel-holders.yml").jobs.refresh.steps;
    const idx = (needle, from = 0) => steps.findIndex((s, i) => i >= from && (s.run ?? "").includes(needle));
    const holders = idx("pull-holders-rpc.js");
    const commit1 = idx("git commit", holders);
    const flows = idx("scan-exchange-flows.js", commit1);
    const tiers = idx("generate-tier-outflows.js", flows);
    const gaps = idx("fill-history-gaps.js", tiers);
    const gate = idx("check-feed-consistency.js", gaps);
    const commit2 = idx("git commit", gate);
    for (const [name, i] of Object.entries({ holders, commit1, flows, tiers, gaps, gate, commit2 })) {
      expect(i, `missing or out-of-order stage: ${name}`).toBeGreaterThanOrEqual(0);
    }
    // Downstream stages are time-boxed and non-fatal so one slow scan cannot
    // eat the minute budget or block the holders publish.
    for (const i of [flows, tiers, gaps]) {
      expect(steps[i]["continue-on-error"]).toBe(true);
      expect(steps[i]["timeout-minutes"]).toBeGreaterThan(0);
    }
    // Archive-state reads stay on the keys; only log scanners prefer public RPC.
    expect(steps[gaps].env?.RPC_PREFER_PUBLIC).toBeUndefined();
    expect(steps[flows].env?.RPC_PREFER_PUBLIC).toBe("1");
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
