// scripts/push-main.sh against real git repos (a bare "origin" and two clones in a
// temp dir): the lost-race rebase merges rpc-usage.json counters, and any other
// conflict still aborts with exit 1. Reproduces the 2026-11-21 / 2026-11-24 hedera
// ledger failure: two jobs each added a run to the same day of the same usage file.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateRuns, mergeUsage } from "./lib/runMetricsSummary.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_FILES = ["scripts/push-main.sh", "scripts/merge-rpc-usage.js", "scripts/lib/rpcUsageMerge.js", "scripts/lib/runMetricsSummary.js"];
const USAGE = "data/demo/rpc-usage.json";
const DAY = "2026-11-24";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

let tmp;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
const writeJson = (dir, rel, v) => write(dir, rel, `${JSON.stringify(v, null, 2)}\n`);
const copyTools = (dir) => {
  for (const f of TOOL_FILES) write(dir, f, fs.readFileSync(path.join(REPO, f), "utf8"));
};
const addRun = (dir, script, publicCalls) => {
  const agg = aggregateRuns([{ script, pid: 1, alchemyCu: 0, heliusCredits: 0, alchemyCalls: 0, heliusCalls: 0, publicCalls }]);
  writeJson(dir, USAGE, mergeUsage(readJson(dir, USAGE), DAY, agg));
};
const commitAll = (dir, msg) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};
const pushMain = (dir) => spawnSync("bash", ["scripts/push-main.sh"], { cwd: dir, env: ENV, encoding: "utf8" });
const clone = (name) => {
  const dir = path.join(tmp, name);
  git(tmp, "clone", "-q", path.join(tmp, "origin.git"), dir);
  return dir;
};

/** origin/main holds a usage file with one run on DAY (and the push tooling unless `withTools` is false). */
function seed({ withTools = true } = {}) {
  git(tmp, "init", "-q", "--bare", "-b", "main", "origin.git");
  const dir = path.join(tmp, "seed");
  git(tmp, "init", "-q", "-b", "main", dir);
  if (withTools) copyTools(dir);
  writeJson(dir, USAGE, mergeUsage(null, DAY, aggregateRuns([{ script: "generate-wallet-flows-hedera.js", pid: 1, publicCalls: 51 }])));
  write(dir, "data/demo/other.json", '{\n  "value": 1\n}\n');
  commitAll(dir, "seed");
  git(dir, "remote", "add", "origin", path.join(tmp, "origin.git"));
  git(dir, "push", "-q", "origin", "main");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "push-main-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scripts/push-main.sh", () => {
  it("baseline: git's own rebase conflicts on two runs added to the same day (the bug)", () => {
    seed();
    const holders = clone("holders");
    const ledger = clone("ledger");
    addRun(holders, "pull-holders-rpc.js", 101576);
    commitAll(holders, "holders");
    expect(pushMain(holders).status).toBe(0);
    addRun(ledger, "build-ledger.js", 10);
    commitAll(ledger, "ledger");
    git(ledger, "fetch", "-q", "origin", "main");
    const plain = spawnSync("git", ["rebase", "origin/main"], { cwd: ledger, env: ENV, encoding: "utf8" });
    expect(plain.status).not.toBe(0);
    expect(git(ledger, "diff", "--name-only", "--diff-filter=U")).toBe(USAGE);
    git(ledger, "rebase", "--abort");
  });

  it("merges the usage counters on a lost race and pushes, keeping every run", () => {
    seed();
    const holders = clone("holders");
    const ledger = clone("ledger"); // starts from the same, soon stale, commit
    addRun(holders, "pull-holders-rpc.js", 101576);
    commitAll(holders, "holders");
    expect(pushMain(holders).status).toBe(0);

    addRun(ledger, "build-ledger.js", 10);
    write(ledger, "data/demo/ledger/ledger.json", "{}\n");
    commitAll(ledger, "ledger");
    const res = pushMain(ledger);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const check = clone("check");
    const day = readJson(check, USAGE).days[DAY];
    expect(day).toMatchObject({ runs: 3, publicCalls: 51 + 101576 + 10 });
    expect(Object.keys(day.byScript).sort()).toEqual(["build-ledger.js", "generate-wallet-flows-hedera.js", "pull-holders-rpc.js"]);
    expect(fs.existsSync(path.join(check, "data/demo/ledger/ledger.json"))).toBe(true);
    expect(git(check, "log", "--format=%s")).toBe("ledger\nholders\nseed");
    // Nothing was written to git config or .gitattributes.
    expect(fs.existsSync(path.join(check, ".gitattributes"))).toBe(false);
    expect(spawnSync("git", ["config", "--get-regexp", "^merge\\."], { cwd: ledger, env: ENV }).status).not.toBe(0);
  });

  it("sums counters when both sides made the identical edit (git would keep it once)", () => {
    seed();
    const a = clone("a");
    const b = clone("b");
    addRun(a, "x.js", 100);
    commitAll(a, "a");
    expect(pushMain(a).status).toBe(0);

    addRun(b, "x.js", 100);
    expect(readJson(b, USAGE)).toEqual(readJson(clone("a-pushed"), USAGE));
    write(b, "data/demo/ledger/ledger.json", "{}\n");
    commitAll(b, "b");

    // git treats the identical usage hunk as already applied and never calls the
    // merge driver, so a plain rebase keeps one increment (runs 2, not 3).
    const beforeRebase = git(b, "rev-parse", "HEAD");
    git(b, "fetch", "-q", "origin", "main");
    const plain = spawnSync("git", ["rebase", "origin/main"], { cwd: b, env: ENV, encoding: "utf8" });
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(readJson(b, USAGE).days[DAY].runs).toBe(2);
    git(b, "reset", "--hard", "-q", beforeRebase);

    const res = pushMain(b);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const day = readJson(clone("check-identical"), USAGE).days[DAY];
    expect(day.runs).toBe(3);
    expect(day.publicCalls).toBe(51 + 100 + 100);
    expect(day.byScript["x.js"]).toMatchObject({ processes: 2, publicCalls: 200 });
    expect(fs.existsSync(path.join(clone("check-identical-files"), "data/demo/ledger/ledger.json"))).toBe(true);
  });

  it("sums identical usage-only edits when git drops the empty replayed commit", () => {
    seed();
    const a = clone("a");
    const b = clone("b");
    addRun(a, "x.js", 100);
    commitAll(a, "a");
    expect(pushMain(a).status).toBe(0);

    addRun(b, "x.js", 100);
    commitAll(b, "b");
    const res = pushMain(b);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const check = clone("check-identical-only");
    const day = readJson(check, USAGE).days[DAY];
    expect(day.runs).toBe(3);
    expect(day.publicCalls).toBe(51 + 100 + 100);
    expect(day.byScript["x.js"]).toMatchObject({ processes: 2, publicCalls: 200 });
    expect(git(check, "log", "--format=%s")).toBe("b\na\nseed");
  });

  it("merges even when origin/main predates the merge driver (the night the fix lands)", () => {
    seed({ withTools: false });
    const holders = clone("holders");
    const ledger = clone("ledger");
    addRun(holders, "pull-holders-rpc.js", 100);
    commitAll(holders, "holders");
    git(holders, "push", "-q", "origin", "HEAD:main");

    copyTools(ledger);
    addRun(ledger, "build-ledger.js", 10);
    commitAll(ledger, "ledger with tooling");
    const res = pushMain(ledger);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(readJson(clone("check"), USAGE).days[DAY]).toMatchObject({ runs: 3, publicCalls: 161 });
  });

  it("still aborts on a conflict in any other file, names it, and leaves the commit intact", () => {
    seed();
    const a = clone("a");
    const b = clone("b");
    write(a, "data/demo/other.json", '{\n  "value": 2\n}\n');
    addRun(a, "pull-holders-rpc.js", 5);
    commitAll(a, "a");
    expect(pushMain(a).status).toBe(0);

    write(b, "data/demo/other.json", '{\n  "value": 3\n}\n');
    addRun(b, "build-ledger.js", 1);
    commitAll(b, "b");
    const head = git(b, "rev-parse", "HEAD");
    const res = pushMain(b);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("conflicted paths:");
    expect(res.stdout).toContain("data/demo/other.json");
    expect(res.stdout).not.toMatch(/^data\/demo\/rpc-usage\.json$/m);
    expect(res.stdout).toContain("::error::rebase onto origin/main conflicted; not retrying");
    expect(git(b, "rev-parse", "HEAD")).toBe(head);
    expect(fs.existsSync(path.join(b, ".git", "rebase-merge"))).toBe(false);
    expect(readJson(clone("check"), "data/demo/other.json").value).toBe(2);
  });

  it("leaves a usage file it cannot parse as a conflict (no guessed counts)", () => {
    seed();
    const a = clone("a");
    const b = clone("b");
    addRun(a, "pull-holders-rpc.js", 5);
    commitAll(a, "a");
    expect(pushMain(a).status).toBe(0);
    write(b, USAGE, "{ not json\n");
    commitAll(b, "b");
    const head = git(b, "rev-parse", "HEAD");
    const res = pushMain(b);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[merge-rpc-usage] cannot merge");
    expect(res.stderr).toContain(USAGE);
    expect(res.stdout).toContain("::error::could not merge rpc-usage.json counters; not retrying");
    expect(git(b, "rev-parse", "HEAD")).toBe(head);
  });
});
