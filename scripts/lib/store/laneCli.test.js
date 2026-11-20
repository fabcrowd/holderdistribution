import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as packMain } from "../../store-pack.js";
import { main as restoreMain } from "../../store-restore.js";
import { LaneArgError, fileGit, layoutFromRegistry, parseLaneArgs } from "./laneCli.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { writeNightFiles, writeOriginFacts } from "./laneKit.js";
import { OriginFactsError } from "./laneNames.js";

// The two CLIs end to end on a folder store, with a registry of neutral slugs in a temporary root and the
// origin/main facts as files (no git, no network).
const made = [];
const tmp = (n) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lanecli-${n}-`));
  made.push(d);
  return d;
};
afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repoRoot() {
  const root = tmp("repo");
  fs.mkdirSync(path.join(root, "config/projects"), { recursive: true });
  fs.writeFileSync(path.join(root, "config/projects.json"), JSON.stringify({ projects: [{ slug: "coin-a", name: "A", ticker: "AAA", default: true }, { slug: "coin-b", name: "B", ticker: "BBB" }] }));
  for (const s of ["coin-a", "coin-b"]) fs.writeFileSync(path.join(root, `config/projects/${s}.json`), "{}");
  return root;
}

const quiet = () => {
  const lines = { log: [], error: [] };
  return { logger: { log: (m) => lines.log.push(m), error: (m) => lines.error.push(m) }, lines };
};

const specs = path.resolve(import.meta.dirname, "laneKitSpecs.js");

describe("parseLaneArgs and fileGit", () => {
  it("collects repeated and comma-listed projects and refuses an unknown name", () => {
    expect(parseLaneArgs(["--project", "a,b", "--project", "c", "--kind", "holders"], ["project", "kind"])).toEqual({ project: ["a", "b", "c"], kind: "holders" });
    expect(() => parseLaneArgs(["--nope", "x"], ["kind"])).toThrow(LaneArgError);
    expect(() => parseLaneArgs(["--kind"], ["kind"])).toThrow(LaneArgError);
  });

  it("refuses a coin named twice in --project", () => {
    expect(() => parseLaneArgs(["--project", "a,b", "--project", "a"], ["project"])).toThrow(LaneArgError);
    expect(() => parseLaneArgs(["--project", "a,a"], ["project"])).toThrow(/names a twice/);
  });

  it("reads the origin facts from files: a manifest, the explicit no-manifest marker, the store file, the history with its own completeness", async () => {
    const dir = tmp("origin");
    writeOriginFacts(dir, {
      manifests: { "coin-a": null, "coin-b": '{"schema":1}' }, store: '{"schema":1,"releases":{}}',
      history: { commits: [{ sha: "abc1234", committedAt: "2026-11-01T00:00:00Z", files: ["scripts/x.js"] }], complete: false }, head: ["abc1234"],
    });
    const git = fileGit(dir);
    expect(await git.readManifest("coin-a")).toBeNull();
    expect(await git.readManifest("coin-b")).toBe('{"schema":1}');
    expect(await git.readStoreFile()).toBe('{"schema":1,"releases":{}}');
    expect(await git.firstParentHistory()).toEqual({ commits: [{ sha: "abc1234", committedAt: "2026-11-01T00:00:00Z", files: ["scripts/x.js"] }], complete: false });
    expect(await git.isAncestor("abc1234")).toBe(true);
    expect(await git.isAncestor("def5678")).toBe(false);
  });

  it("a missing origin file is a named error, never an empty answer", async () => {
    const empty = fileGit(tmp("empty"));
    for (const call of [() => empty.readManifest("coin-a"), () => empty.readStoreFile(), () => empty.firstParentHistory(), () => empty.isAncestor("abc1234")]) {
      await expect(call()).rejects.toThrow(OriginFactsError);
    }
    await expect(empty.readManifest("coin-a")).rejects.toThrow(/manifests\/coin-a\.json/);
    const noHead = tmp("nohead");
    writeOriginFacts(noHead);
    fs.rmSync(path.join(noHead, "head-commits.txt"));
    await expect(fileGit(noHead).firstParentHistory()).rejects.toThrow(/head-commits\.txt/);
  });

  it("history.json must say commits and complete itself, and a manifest and its marker together are refused", async () => {
    const dir = tmp("origin");
    writeOriginFacts(dir, { manifests: { "coin-a": '{"schema":1}' } });
    fs.writeFileSync(path.join(dir, "manifests/coin-a.absent"), "");
    await expect(fileGit(dir).readManifest("coin-a")).rejects.toThrow(/both/);
    for (const bad of ["[]", '{"commits":[]}', '{"commits":[],"complete":"yes"}', '{"commits":{},"complete":true}', "{ nope"]) {
      fs.writeFileSync(path.join(dir, "history.json"), bad);
      await expect(fileGit(dir).firstParentHistory(), bad).rejects.toThrow(OriginFactsError);
    }
  });
});

describe("layoutFromRegistry", () => {
  it("a coin with its own directories has none shared; a coin whose directory holds the others' is on shared roots", () => {
    const root = repoRoot();
    expect(layoutFromRegistry("coin-b", root)).toMatchObject({ dataDir: "public/data/coin-b", workDir: "data/coin-b", ledgerDir: "data/coin-b/ledger", shared: [], others: ["coin-a"] });
    fs.writeFileSync(path.join(root, "config/projects/coin-a.json"), JSON.stringify({ data: { legacyRoot: true } }));
    const shared = layoutFromRegistry("coin-a", root);
    expect(shared).toMatchObject({ dataDir: "public/data", workDir: "data", ledgerDir: "data/coin-a/ledger", sharedRoots: true, shared: ["coin-a", "coin-b"] });
  });

  it("a coin's hand-kept files come from its registry config (excludedFiles), none when it names none", () => {
    const root = repoRoot();
    expect(layoutFromRegistry("coin-a", root).excludedFiles).toEqual([]);
    fs.writeFileSync(path.join(root, "config/projects/coin-a.json"), JSON.stringify({ excludedFiles: ["hand-kept/notes.json"] }));
    expect(layoutFromRegistry("coin-a", root).excludedFiles).toEqual(["hand-kept/notes.json"]);
    expect(layoutFromRegistry("coin-b", root).excludedFiles).toEqual([]);
  });
});

describe("the release backend path of the CLIs", () => {
  it("packs through an injected HTTP client on the fake release server and stores live and history items", async () => {
    const root = repoRoot();
    const server = createFakeReleaseServer({ token: "fake-token" });
    const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "fake-token" };
    const origin = tmp("origin");
    writeOriginFacts(origin, { manifests: { "coin-a": null, "coin-b": null } });
    const work = tmp("work");
    const start = tmp("start");
    const common = ["--kind", "holders", "--project", "coin-a", "--origin-dir", origin, "--table-specs", specs];
    const opts = (q) => ({ logger: q.logger, root, env, http: server.http });
    expect(await restoreMain([...common, "--out-dir", work, "--start-dir", start], opts(quiet()))).toBe(0);
    await writeNightFiles(work, "coin-a", 1);
    const q = quiet();
    const code = await packMain([...common, "--run-id", "9", "--attempt", "1", "--lane", "0", "--day", "2026-11-18", "--root", work, "--start-dir", start,
      "--candidate-dir", tmp("cand"), "--spool-dir", tmp("spool")], opts(q));
    expect(code, q.lines.error.join(" | ")).toBe(0);
    expect(server.releases.some((r) => r.tag_name.startsWith("data-live-") && r.assets.length > 0)).toBe(true);
    expect(server.releases.some((r) => r.tag_name.startsWith("data-hist-") && r.assets.length > 0)).toBe(true);
  });

  it("no store directory and no repository or token is a LaneArgError", async () => {
    const q = quiet();
    await expect(restoreMain(["--kind", "holders", "--project", "coin-a", "--origin-dir", tmp("o"), "--out-dir", tmp("w"), "--start-dir", tmp("s")], { logger: q.logger, root: repoRoot(), env: {} })).rejects.toThrow(LaneArgError);
  });
});

describe("store-restore.js and store-pack.js", () => {
  it("restore a new coin, then pack it: packs reach the store and the candidate is written", async () => {
    const root = repoRoot();
    const storeDir = tmp("store");
    const origin = tmp("origin");
    writeOriginFacts(origin, { manifests: { "coin-a": null, "coin-b": null } });
    const work = tmp("work");
    const start = tmp("start");
    const common = ["--kind", "holders", "--project", "coin-a,coin-b", "--origin-dir", origin, "--store-dir", storeDir, "--table-specs", specs];
    const q1 = quiet();
    expect(await restoreMain([...common, "--out-dir", work, "--start-dir", start], { logger: q1.logger, root })).toBe(0);
    expect(q1.lines.log[0]).toContain("2 ok, 0 failed");
    for (const s of ["coin-a", "coin-b"]) await writeNightFiles(work, s, 1);
    const q2 = quiet();
    const code = await packMain([...common, "--run-id", "9", "--attempt", "1", "--lane", "0", "--day", "2026-11-18", "--root", work, "--start-dir", start,
      "--candidate-dir", tmp("cand"), "--spool-dir", tmp("spool")], { logger: q2.logger, root });
    expect(code, q2.lines.error.join("\n")).toBe(0);
    expect(q2.lines.log.join("\n")).toContain("2 ok, 0 failed");
    expect(fs.readdirSync(path.join(storeDir)).some((d) => d.startsWith("data-live-"))).toBe(true);
  });

  it("an unknown kind or a missing argument is a LaneArgError (exit code 2 in the CLI)", async () => {
    await expect(restoreMain(["--kind", "nightly", "--project", "x", "--origin-dir", "o", "--out-dir", "o", "--start-dir", "s"], { logger: quiet().logger })).rejects.toThrow(LaneArgError);
    await expect(packMain(["--kind", "holders"], { logger: quiet().logger })).rejects.toThrow(/--project is required/);
  });

  it("an empty or valueless --attempt-start is a named LaneArgError, never silently now", async () => {
    const base = ["--kind", "holders", "--project", "x", "--origin-dir", "o", "--out-dir", "o", "--start-dir", "s"];
    for (const tail of [["--attempt-start", ""], ["--attempt-start"]]) {
      await expect(restoreMain([...base, ...tail], { logger: quiet().logger })).rejects.toThrow(/--attempt-start/);
      await expect(restoreMain([...base, ...tail], { logger: quiet().logger })).rejects.toThrow(LaneArgError);
    }
  });

  it("a coin that fails to pack is reported on stderr and the others still pack", async () => {
    const root = repoRoot();
    const storeDir = tmp("store");
    const origin = tmp("origin");
    writeOriginFacts(origin, { manifests: { "coin-a": null, "coin-b": null } });
    const work = tmp("work");
    const start = tmp("start");
    const common = ["--kind", "holders", "--project", "coin-a,coin-b", "--origin-dir", origin, "--store-dir", storeDir, "--table-specs", specs];
    await restoreMain([...common, "--out-dir", work, "--start-dir", start], { logger: quiet().logger, root });
    await writeNightFiles(work, "coin-a", 1);
    await writeNightFiles(work, "coin-b", 1, { extra: { "public/data/coin-b/x.json#slice.0": "x" } });
    const q = quiet();
    const code = await packMain([...common, "--run-id", "9", "--attempt", "1", "--lane", "0", "--day", "2026-11-18", "--root", work, "--start-dir", start,
      "--candidate-dir", tmp("cand"), "--spool-dir", tmp("spool")], { logger: q.logger, root });
    expect(code).toBe(0);
    expect(q.lines.error.join("\n")).toContain("FAILED coin-b [pack] UnclassifiedFileError");
    expect(q.lines.log[0]).toContain("1 ok, 1 failed");
  });
});
