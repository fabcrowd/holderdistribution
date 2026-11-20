import { describe, expect, it } from "vitest";
import {
  STALE_CODE_REASON, StaleCodeError, StaleCodeInputError, assertCodeCurrent, checkStaleCode, touchesGuardedPath,
} from "./staleCodeGuard.js";

const sha = (n) => n.toString(16).padStart(40, "0");
const commit = (n, committedAt, files = ["scripts/a.js"]) => ({ sha: sha(n), committedAt, files });
const T = "2026-11-18T10:00:00Z";

// ancestors: the shas the job's own commit contains.
const ancestry = (...have) => {
  const calls = [];
  const fn = (s) => {
    calls.push(s);
    return have.map(sha).includes(s);
  };
  fn.calls = calls;
  return fn;
};
const run = (over) => checkStaleCode({ attemptStart: T, complete: true, commits: [], isAncestor: ancestry(), ...over });

describe("stale-code guard, the cases of design 9.4", () => {
  it("an empty commit list passes and asks git nothing", async () => {
    const isAncestor = ancestry();
    expect(await run({ isAncestor })).toEqual({ ok: true, checked: 0 });
    expect(isAncestor.calls).toEqual([]);
  });

  it("passes when every commit of the guarded paths dated at or before the start is an ancestor", async () => {
    const isAncestor = ancestry(1, 2);
    const r = await run({ commits: [commit(1, "2026-11-10T00:00:00Z"), commit(2, "2026-11-17T00:00:00Z")], isAncestor });
    expect(r).toEqual({ ok: true, checked: 2 });
  });

  it("refuses with the fixed reason and names a commit that is not an ancestor", async () => {
    const r = await run({ commits: [commit(1, "2026-11-10T00:00:00Z"), commit(2, "2026-11-17T00:00:00Z")], isAncestor: ancestry(1) });
    expect(r).toMatchObject({ ok: false, reason: "run is older than the code on main", commit: { sha: sha(2), committedAt: "2026-11-17T00:00:00Z" } });
    expect(STALE_CODE_REASON).toBe("run is older than the code on main");
  });

  it("a pull request merged during a long nightly (dated after the start) never stops it", async () => {
    const isAncestor = ancestry();
    const r = await run({ commits: [commit(7, "2026-11-18T10:00:01Z")], isAncestor });
    expect(r).toEqual({ ok: true, checked: 0 });
    expect(isAncestor.calls).toEqual([]);
  });

  it("a rerun of an old run after a code change is stopped; the first attempt, started before the change, was not", async () => {
    const merged = commit(5, "2026-11-18T11:00:00Z", [".github/workflows/refresh-holders.yml"]);
    const firstAttempt = await checkStaleCode({ attemptStart: "2026-11-18T10:30:00Z", complete: true, commits: [merged], isAncestor: ancestry() });
    expect(firstAttempt.ok).toBe(true);
    const rerun = await checkStaleCode({ attemptStart: "2026-11-18T12:00:00Z", complete: true, commits: [merged], isAncestor: ancestry() });
    expect(rerun).toMatchObject({ ok: false, reason: STALE_CODE_REASON, commit: { sha: sha(5) } });
  });

  it("a commit that changes only config is not compared, even when it is not an ancestor", async () => {
    const isAncestor = ancestry();
    const onboarding = commit(3, "2026-11-18T09:00:00Z", ["config/projects/example.json", "public/tokens/example.png", "data/manifests/example.json"]);
    expect(await run({ commits: [onboarding], isAncestor })).toEqual({ ok: true, checked: 0 });
    expect(isAncestor.calls).toEqual([]);
  });

  it("a commit that changes config and code is compared", async () => {
    const mixed = commit(3, "2026-11-18T09:00:00Z", ["config/projects/example.json", "scripts/lib/x.js"]);
    expect((await run({ commits: [mixed] })).ok).toBe(false);
  });

  it("a commit dated exactly at the start counts (at or before); one millisecond later does not", async () => {
    expect((await run({ commits: [commit(1, "2026-11-18T10:00:00.000Z")] })).ok).toBe(false);
    expect((await run({ commits: [commit(1, "2026-11-18T10:00:00.001Z")] })).ok).toBe(true);
  });

  it("dates are compared as instants, whatever offset they are written in", async () => {
    // 11:30+02:00 is 09:30Z, before the start; 12:30+02:00 is 10:30Z, after it.
    expect((await run({ commits: [commit(1, "2026-11-18T11:30:00+02:00")] })).ok).toBe(false);
    expect((await run({ commits: [commit(1, "2026-11-18T12:30:00+02:00")] })).ok).toBe(true);
  });

  it("names the oldest commit that is not an ancestor, whatever the order of the list", async () => {
    const list = [commit(3, "2026-11-17T00:00:00Z"), commit(1, "2026-11-12T00:00:00Z"), commit(2, "2026-11-15T00:00:00Z")];
    const r = await run({ commits: list, isAncestor: ancestry(2) });
    expect(r.commit.sha).toBe(sha(1));
  });

  it("an equal date is ordered by sha, so the answer does not depend on input order", async () => {
    const a = commit(9, "2026-11-12T00:00:00Z");
    const b = commit(4, "2026-11-12T00:00:00Z");
    expect((await run({ commits: [a, b] })).commit.sha).toBe(sha(4));
    expect((await run({ commits: [b, a] })).commit.sha).toBe(sha(4));
  });

  it("accepts an asynchronous isAncestor", async () => {
    const isAncestor = async (s) => s === sha(1);
    expect((await run({ commits: [commit(1, "2026-11-10T00:00:00Z")], isAncestor })).ok).toBe(true);
    expect((await run({ commits: [commit(2, "2026-11-10T00:00:00Z")], isAncestor })).ok).toBe(false);
  });

  it("accepts the start as a Date", async () => {
    expect((await run({ attemptStart: new Date("2026-11-18T09:00:00Z"), commits: [commit(1, "2026-11-18T09:30:00Z")] })).ok).toBe(true);
  });

  it("does not change its arguments", async () => {
    const commits = Object.freeze([Object.freeze({ ...commit(1, "2026-11-10T00:00:00Z"), files: Object.freeze(["scripts/a.js"]) })]);
    await expect(run({ commits })).resolves.toMatchObject({ ok: false });
  });

  it("an error from isAncestor is thrown, never read as 'not an ancestor' or 'ancestor'", async () => {
    const isAncestor = () => { throw new Error("git is not available"); };
    await expect(run({ commits: [commit(1, "2026-11-10T00:00:00Z")], isAncestor })).rejects.toThrow(/git is not available/);
  });
});

describe("which paths are compared", () => {
  it.each(["scripts/a.js", "scripts/lib/store/x.js", ".github/workflows/a.yml", "package.json", "package-lock.json"])("%s is", (f) => {
    expect(touchesGuardedPath(f)).toBe(true);
  });
  it.each(["config/projects.json", "config/projects/example.json", "public/tokens/a.png", "data/manifests/example.json", "src/lib/a.ts",
    "scripts-old/a.js", "myscripts/a.js", ".github-x/a.yml", "docs/package.json", "package.jsonc", "package-lock.json.bak", "README.md"])("%s is not", (f) => {
    expect(touchesGuardedPath(f)).toBe(false);
  });
});

describe("assertCodeCurrent", () => {
  it("returns on ok and throws a named error that carries the commit when stale", async () => {
    await expect(assertCodeCurrent({ attemptStart: T, complete: true, commits: [], isAncestor: ancestry() })).resolves.toEqual({ ok: true, checked: 0 });
    const err = await assertCodeCurrent({ attemptStart: T, complete: true, commits: [commit(1, "2026-11-10T00:00:00Z")], isAncestor: ancestry() }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleCodeError);
    expect(err.message).toMatch(/run is older than the code on main/);
    expect(err.message).toContain(sha(1));
    expect(err.commit.sha).toBe(sha(1));
  });
});

describe("a bad argument is a named input error, never a silent pass", () => {
  const bad = (over) => expect(run(over)).rejects.toThrow(StaleCodeInputError);
  it("start", async () => {
    await bad({ attemptStart: undefined });
    await bad({ attemptStart: "yesterday" });
    await bad({ attemptStart: "2026-11-18" }); // no time: ambiguous zone
    await bad({ attemptStart: new Date("nope") });
  });
  it("commits", async () => {
    await bad({ commits: "x" });
    await bad({ commits: [null] });
    await bad({ commits: [{ ...commit(1, T), sha: "xyz" }] });
    await bad({ commits: [{ ...commit(1, T), committedAt: "soon" }] });
    await bad({ commits: [{ ...commit(1, T), files: "scripts/a.js" }] });
    await bad({ commits: [{ ...commit(1, T), files: [1] }] });
    await bad({ commits: [{ sha: sha(1), committedAt: T }] }); // no files: it could hide a code change
  });
  it("a listed commit with an empty files list is an input error: the command lists only commits that touch a path", async () => {
    await bad({ commits: [{ ...commit(1, T), files: [] }] });
    await expect(run({ commits: [{ ...commit(1, T), files: [] }] })).rejects.toThrow(/commits\[0\]\.files is empty.*2\.31/s);
  });
  it("isAncestor", async () => {
    await bad({ isAncestor: undefined });
    await bad({ commits: [commit(1, "2026-11-10T00:00:00Z")], isAncestor: () => "yes" });
  });
  it("the message names the field", async () => {
    await expect(run({ attemptStart: "later" })).rejects.toThrow(/attemptStart/);
    await expect(run({ commits: [{ ...commit(1, T), sha: "xyz" }] })).rejects.toThrow(/commits\[0\]\.sha/);
  });
});

describe("the caller's obligation: the complete first-parent history", () => {
  it("a cut list must say so: complete is required to be true", async () => {
    for (const complete of [undefined, false, "yes", 1]) {
      await expect(run({ complete })).rejects.toThrow(StaleCodeInputError);
      await expect(run({ complete })).rejects.toThrow(/complete/);
    }
    await expect(assertCodeCurrent({ attemptStart: T, commits: [], isAncestor: ancestry() })).rejects.toThrow(/complete/);
  });

  it("a branch commit dated a day before the attempt start, merged by a merge commit after it, is not in a first-parent list: it does not stop the run", async () => {
    // The merge commit (dated after the start) is the first-parent entry; the branch commit is not listed.
    const merge = commit(8, "2026-11-18T10:20:00Z");
    const branch = commit(7, "2026-11-17T10:00:00Z");
    expect((await run({ commits: [merge], isAncestor: ancestry() })).ok).toBe(true);
    // A caller that listed every parent (git log without --first-parent) hands in the branch commit
    // too: it is not an ancestor of the job's commit and dated before the start, so it stops a
    // nightly that is current in every way that matters. That caller is wrong, not the guard.
    expect((await run({ commits: [merge, branch], isAncestor: ancestry() })).ok).toBe(false);
  });
});
