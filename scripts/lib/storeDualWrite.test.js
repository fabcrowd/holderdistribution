import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "yaml";

/**
 * Guards the store dual-write wiring of refresh-holders.yml (design 2.1 section 16, 2.3a part 1): no store step may
 * stop the git data path, and the kill switch must turn every store step off.
 */
const WORKFLOW = path.resolve(process.cwd(), ".github/workflows/refresh-holders.yml");
const GUARD = path.resolve(process.cwd(), "scripts/store-guard.sh");
const doc = yaml.parse(fs.readFileSync(WORKFLOW, "utf8"));
const laneSteps = doc.jobs.refresh.steps;
const storeSteps = laneSteps.filter((s) => /^Store /.test(s.name));
const names = laneSteps.map((s) => s.name);

const START = "Store start (dual-write, never blocks)";
const PACK = "Store pack (dual-write, never blocks)";

describe("lane store steps", () => {
  it("exist, and each is gated on the kill switch", () => {
    expect(storeSteps.map((s) => s.name)).toEqual([START, PACK, "Store candidate upload", "Store summary", "Store status upload"]);
    for (const s of storeSteps) expect(String(s.if), s.name).toContain("needs.plan.outputs.store == 'on'");
  });

  it("nothing store-related runs before the git data commits (start, pack, upload, summary all come after them)", () => {
    const lastPush = Math.max(names.indexOf("Commit snapshot changes"), names.indexOf("Commit downstream feeds"));
    for (const s of storeSteps) expect(names.indexOf(s.name), s.name).toBeGreaterThan(lastPush);
    expect(names.indexOf(START)).toBeLessThan(names.indexOf(PACK));
  });

  it("never turn the run red: continue-on-error, a store_ id, and absent from the Stage verdict", () => {
    const verdict = laneSteps.find((s) => s.name === "Stage verdict");
    for (const s of storeSteps) {
      expect(s["continue-on-error"], s.name).toBe(true);
      expect(s.id, s.name).toMatch(/^store_/);
      expect(Object.values(verdict.env).some((v) => String(v).includes(`steps.${s.id}.`)), s.name).toBe(false);
    }
    expect(String(verdict.run)).not.toContain("store_");
  });

  it("every store step has a small timeout-minutes, and each command's timeout is below it", () => {
    for (const s of storeSteps) {
      expect(s["timeout-minutes"], s.name).toBeGreaterThan(0);
      expect(s["timeout-minutes"], s.name).toBeLessThanOrEqual(6);
      if (s.env?.HD_STORE_TIMEOUT) expect(Number(s.env.HD_STORE_TIMEOUT), s.name).toBeLessThan(s["timeout-minutes"] * 60);
    }
    const minutes = Object.fromEntries(storeSteps.map((s) => [s.name, s["timeout-minutes"]]));
    expect(minutes).toEqual({ [START]: 3, [PACK]: 6, "Store candidate upload": 3, "Store summary": 2, "Store status upload": 2 });
    // start chains three commands (fetch, facts, restore): together they must fit in the step
    expect(Number(storeSteps.find((s) => s.name === START).env.HD_STORE_TIMEOUT) * 3).toBeLessThan(minutes[START] * 60);
    expect(Number(storeSteps.find((s) => s.name === PACK).env.HD_STORE_TIMEOUT)).toBe(300);
  });

  it("every store command runs through the guard", () => {
    for (const s of storeSteps.filter((x) => x.run)) {
      const commands = s.run.split("\n").filter((l) => /\bnode scripts\/store-|\bgit fetch\b/.test(l) && !l.trim().startsWith("#"));
      for (const line of commands) expect(line, `${s.name}: ${line}`).toMatch(/\$G |store-guard\.sh /);
    }
  });

  it("the publish job's overlay goes through store-overlay.js, which clears the absent markers, not a bare cp", () => {
    const publishJob = Object.values(doc.jobs).find((j) => (j.steps ?? []).some((s) => /store-overlay\.js/.test(s.run ?? "")));
    const run = publishJob.steps.find((s) => /store-overlay\.js/.test(s.run ?? "")).run;
    const line = run.split("\n").find((l) => /store-overlay\.js/.test(l));
    expect(line).toMatch(/\$G --after accepted overlay node scripts\/store-overlay\.js /);
    expect(run).not.toMatch(/cp -r "\$HD_STORE_DIR\/origin"/);
  });

  it("pack uses the settled day of the lane's own snapshot, not a clock", () => {
    const pack = storeSteps.find((s) => s.name === PACK).run;
    expect(pack).toContain("holders-summary.json");
    expect(pack).toContain(".asOf.date");
    expect(pack).not.toMatch(/\bdate\b\s+-u|\$\(date/);
    expect(pack).toMatch(/--day "\$\(cat /);
  });

  it("restore writes to a scratch directory, never into the checkout", () => {
    const start = storeSteps.find((s) => s.name === START).run;
    expect(start).toContain('--out-dir "$HD_STORE_DIR/restored"');
    expect(start).not.toMatch(/--out-dir "?\.?"? /);
  });

  it("the attempt start comes from a plan output written by a plan step, never github.run_started_at (not a context field)", () => {
    expect(fs.readFileSync(WORKFLOW, "utf8")).not.toContain("run_started_at");
    const start = storeSteps.find((s) => s.name === START);
    expect(start.env.ATTEMPT_START).toMatch(/^\$\{\{\s*needs\.plan\.outputs\.attempt_start\s*\}\}$/);
    expect(doc.jobs.plan.outputs.attempt_start).toContain("steps.attempt.outputs.attempt_start");
    const step = doc.jobs.plan.steps.find((s) => s.id === "attempt");
    expect(step.run).toContain("date -u +%Y-%m-%dT%H:%M:%SZ");
    expect(step.run).toContain("attempt_start=");
    expect(step.run).toContain("$GITHUB_OUTPUT");
  });

  it("a later attempt (re-run failed jobs reuses the plan outputs) uses the lane's own clock, the same attempt the plan's start", () => {
    expect(doc.jobs.plan.outputs.run_attempt).toMatch(/^\$\{\{\s*github\.run_attempt\s*\}\}$/);
    const start = storeSteps.find((s) => s.name === START);
    expect(start.env.PLAN_ATTEMPT).toMatch(/^\$\{\{\s*needs\.plan\.outputs\.run_attempt\s*\}\}$/);
    expect(start.env.RUN_ATTEMPT).toMatch(/^\$\{\{\s*github\.run_attempt\s*\}\}$/);
    const choice = start.run.split("\n").find((l) => /RUN_ATTEMPT.*PLAN_ATTEMPT.*ATTEMPT_START=/.test(l));
    expect(choice, "the attempt choice line").toBeTruthy();
    expect(start.run.indexOf(choice)).toBeLessThan(start.run.indexOf("store-guard.sh"));
    if (!hasBash) return;
    const pick = (runAttempt, planAttempt) => spawnSync("bash", ["-c", `${choice}\necho "$ATTEMPT_START"`], {
      env: { ...process.env, ATTEMPT_START: "2026-01-01T00:00:00Z", RUN_ATTEMPT: runAttempt, PLAN_ATTEMPT: planAttempt }, encoding: "utf8",
    }).stdout.trim();
    expect(pick("1", "1")).toBe("2026-01-01T00:00:00Z");
    const later = pick("2", "1");
    expect(later).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(later).not.toBe("2026-01-01T00:00:00Z");
  });

  it("a lane files no issue and carries its status in an artifact", () => {
    for (const s of laneSteps) expect(`${s.run ?? ""}`, s.name).not.toMatch(/store-guard\.sh issue|gh issue/);
    const status = storeSteps.find((s) => s.name === "Store status upload");
    expect(status.uses).toContain("actions/upload-artifact");
    expect(status.with.name).toContain("store-status-holders-");
    expect(String(status.if)).toContain("always()");
  });
});

describe("kill switch and publish job", () => {
  it("the plan job exposes `store`, off for anything but on", () => {
    expect(doc.jobs.plan.outputs.store).toContain("steps.store.outputs.store");
    expect(doc.on.workflow_dispatch.inputs.store.default).toBe("on");
    const step = doc.jobs.plan.steps.find((s) => s.id === "store");
    expect(step["continue-on-error"]).toBe(true);
    expect(step.run).toContain("store=off");
  });

  it("the publish job runs only with the switch on, cannot fail the run, and asks for the minimum token rights", () => {
    const job = doc.jobs["store-publish"];
    expect(job.if).toContain("needs.plan.outputs.store == 'on'");
    expect(job["continue-on-error"]).toBe(true);
    expect(job.permissions).toEqual({ contents: "write", issues: "write" });
    const run = job.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("--phase sweep");
    expect(run).toContain("--sweep-mode dry");
    expect(run).toContain("--delete-releases false");
    expect(run).not.toContain("--sweep-mode run");
  });

  it("only the publish job files the issue, once, after aggregating every lane's status", () => {
    const job = doc.jobs["store-publish"];
    const lanes = job.steps.find((s) => s.name === "Download lane status");
    expect(lanes.with.pattern).toBe("store-status-holders-*");
    expect(lanes.with.path).toContain("hd-store/lanes");
    const issueSteps = job.steps.filter((s) => /store-guard\.sh issue/.test(s.run ?? ""));
    expect(issueSteps).toHaveLength(1);
    expect(job.steps.indexOf(issueSteps[0])).toBeGreaterThan(job.steps.indexOf(lanes));
    expect((issueSteps[0].run.match(/store-guard\.sh issue/g) ?? []).length).toBe(1);
    expect(JSON.stringify(doc.jobs.refresh)).not.toContain("store-guard.sh issue");
  });
});

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
describe.skipIf(!hasBash)("store-guard.sh", () => {
  const guard = (dir, args, env = {}) => spawnSync("bash", [GUARD, ...args], { env: { ...process.env, HD_STORE_DIR: dir, ...env }, encoding: "utf8" });
  const status = (dir, name) => fs.readFileSync(path.join(dir, "status", name), "utf8").trim();

  it("always exits 0 and records ok, failed and skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-guard-"));
    expect(guard(dir, ["run", "good", "true"]).status).toBe(0);
    const bad = guard(dir, ["run", "bad", "bash", "-c", "echo boom; exit 3"]);
    expect(bad.status).toBe(0);
    expect(bad.stdout).toContain("::warning");
    expect(guard(dir, ["run", "--after", "bad", "next", "true"]).status).toBe(0);
    expect(guard(dir, ["run", "--after", "good", "after-good", "true"]).status).toBe(0);
    expect(status(dir, "good")).toBe("ok");
    expect(status(dir, "bad")).toBe("failed (exit 3)");
    expect(status(dir, "next")).toMatch(/^skipped/);
    expect(status(dir, "after-good")).toBe("ok");
  });

  it("stops a hung command at the timeout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-guard-"));
    expect(guard(dir, ["run", "hang", "sleep", "5"], { HD_STORE_TIMEOUT: "1" }).status).toBe(0);
    expect(status(dir, "hang")).toBe("failed (exit 124)");
  });

  it("the summary marks a problem for a failed step and for an error issue, not for a notice", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-guard-"));
    guard(dir, ["run", "good", "true"]);
    expect(guard(dir, ["summary", "t"], { GITHUB_STEP_SUMMARY: path.join(dir, "sum.md") }).status).toBe(0);
    expect(fs.existsSync(path.join(dir, "problem"))).toBe(false);
    guard(dir, ["run", "bad", "false"]);
    guard(dir, ["summary", "t"], { GITHUB_STEP_SUMMARY: path.join(dir, "sum.md") });
    expect(fs.existsSync(path.join(dir, "problem"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "report.md"), "utf8")).toContain("step `bad`");
  });

  it("the summary aggregates the lanes' downloaded status folders", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-guard-"));
    fs.mkdirSync(path.join(dir, "lanes", "store-status-holders-l0-a1"), { recursive: true });
    fs.mkdirSync(path.join(dir, "lanes", "store-status-holders-l1-a1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lanes", "store-status-holders-l0-a1", "pack"), "ok\n");
    fs.writeFileSync(path.join(dir, "lanes", "store-status-holders-l1-a1", "pack"), "failed (exit 1)\n");
    guard(dir, ["summary", "t"], { GITHUB_STEP_SUMMARY: path.join(dir, "sum.md") });
    expect(fs.existsSync(path.join(dir, "problem"))).toBe(true);
    const report = fs.readFileSync(path.join(dir, "report.md"), "utf8");
    expect(report).toContain("store-status-holders-l1-a1/pack");
    expect(report).not.toContain("l0-a1");
    expect(fs.readFileSync(path.join(dir, "sum.md"), "utf8")).toContain("store-status-holders-l0-a1/pack | ok");
  });
});
