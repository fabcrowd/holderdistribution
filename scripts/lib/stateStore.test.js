import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonAt, readTextAt, revisionAsOf, versionsByDate } from "./stateStore.js";

let dir;
const FILE = "data/demo/funding-wallets.json";

/** Commit `content` to FILE with the given author and committer dates (ISO, UTC); returns the new revision. */
const commit = (content, authorDate, committerDate = authorDate) => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_DATE: committerDate,
  };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
  fs.mkdirSync(path.join(dir, path.dirname(FILE)), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), content);
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", content);
  return git("rev-parse", "HEAD").trim();
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("versionsByDate", () => {
  it("keeps the newest revision per author date, newest date first", () => {
    const a = commit('{"v":1}', "2026-11-01T08:00:00+00:00");
    commit('{"v":2}', "2026-11-02T08:00:00+00:00");
    const c = commit('{"v":3}', "2026-11-02T20:00:00+00:00");
    const versions = versionsByDate(FILE, { cwd: dir });
    expect([...versions.entries()]).toEqual([["2026-11-02", c], ["2026-11-01", a]]);
  });

  it("is empty for a file with no history", () => {
    commit("{}", "2026-11-01T08:00:00+00:00");
    expect(versionsByDate("data/demo/none.json", { cwd: dir }).size).toBe(0);
  });
});

describe("revisionAsOf", () => {
  it("picks the latest commit on or before the date by committer date, or empty when none", () => {
    const a = commit('{"v":1}', "2026-11-01T08:00:00+00:00", "2026-11-01T08:00:00+00:00");
    const b = commit('{"v":2}', "2026-11-01T09:00:00+00:00", "2026-11-05T09:00:00+00:00");
    expect(revisionAsOf(FILE, "2026-10-31", { cwd: dir })).toBe("");
    expect(revisionAsOf(FILE, "2026-11-03", { cwd: dir })).toBe(a);
    expect(revisionAsOf(FILE, "2026-11-06", { cwd: dir })).toBe(b);
  });
});

describe("readTextAt / readJsonAt", () => {
  it("read the file as of a revision", () => {
    const a = commit('{"v":1}', "2026-11-01T08:00:00+00:00");
    commit('{"v":2}', "2026-11-02T08:00:00+00:00");
    expect(readTextAt(a, FILE, { cwd: dir })).toBe('{"v":1}');
    expect(readJsonAt("HEAD", FILE, { cwd: dir })).toEqual({ v: 2 });
    expect(() => readJsonAt("HEAD", "data/demo/none.json", { cwd: dir, stdio: "pipe" })).toThrow();
  });
});
