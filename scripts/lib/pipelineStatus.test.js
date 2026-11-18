import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { outputTimestamp, projectStatus } from "../write-pipeline-status.js";

const repo = path.resolve(import.meta.dirname, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-status-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// package.json is committed and has no generatedAt-style field, so only the git fallback can date it.
const COMMITTED_NO_FIELD = path.join(repo, "package.json");

describe("outputTimestamp", () => {
  it("reads the file's own time and names the field as its source", () => {
    const f = path.join(tmp, "with-field.json");
    fs.writeFileSync(f, JSON.stringify({ meta: { generatedAt: "2026-11-01T00:00:00.000Z" } }));
    expect(outputTimestamp(f, tmp)).toEqual({ ms: Date.parse("2026-11-01T00:00:00.000Z"), source: "field" });
  });

  it("falls back to git (temporary) for a committed file without a time", () => {
    expect(outputTimestamp(COMMITTED_NO_FIELD, repo)?.source).toBe("git");
  });

  it("refuses the git fallback when asked, so the file has no timestamp", () => {
    expect(outputTimestamp(COMMITTED_NO_FIELD, repo, { allowGit: false })).toBeNull();
  });
});

describe("CLI git-fallback switch", () => {
  const cli = (args, env = {}) => {
    const { PIPELINE_STATUS_NO_GIT: _unset, ...base } = process.env;
    const r = spawnSync(process.execPath, ["scripts/write-pipeline-status.js", "--all", "--no-write", "--json", ...args], { cwd: repo, encoding: "utf8", env: { ...base, ...env } });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout).reports;
  };
  // ageHours moves with the clock between runs; everything else in a row must match.
  const rows = (reports) => reports.flatMap((r) => r.jobs.flatMap((j) => j.outputs.map(({ ageHours: _age, ...o }) => ({ project: r.project, job: j.id, ...o }))));

  it("--no-git-timestamps and PIPELINE_STATUS_NO_GIT=1 give the same rows, none dated by git", () => {
    const byFlag = rows(cli(["--no-git-timestamps"]));
    const byEnv = rows(cli([], { PIPELINE_STATUS_NO_GIT: "1" }));
    expect(byFlag.length).toBeGreaterThan(0);
    expect(byEnv).toEqual(byFlag);
    expect(byFlag.filter((o) => o.timestampSource === "git")).toEqual([]);
  }, 60_000);

  it("still runs with the fallback allowed", () => {
    const reports = cli([]);
    expect(reports.length).toBeGreaterThan(0);
    for (const o of rows(reports)) expect(["field", "git", null]).toContain(o.timestampSource);
  }, 60_000);
});

describe("projectStatus timestamp source", () => {
  const plan = {
    jobs: [{ id: "probe", workflow: "x.yml", providers: ["public"], scripts: [], outputs: [{ path: "package.json", maxAgeHours: 1e9 }] }],
    projects: [{ slug: "tel", jobs: [{ id: "probe", status: "run" }] }],
  };
  const usage = { day: null, byScript: {} };
  const row = (opts) => projectStatus("tel", { root: repo, plan, usage, ...opts }).jobs[0].outputs[0];

  it("adds the source of each output's time", () => {
    expect(row({})).toMatchObject({ path: "package.json", status: "fresh", timestampSource: "git" });
  });

  it("reports no-timestamp with no source when the git fallback is refused", () => {
    expect(row({ allowGitTimestamp: false })).toMatchObject({ status: "no-timestamp", timestampSource: null, generatedAt: null });
  });
});
