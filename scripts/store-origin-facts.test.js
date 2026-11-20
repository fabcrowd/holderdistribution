import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitLog, slugsFromCandidates, writeFacts } from "./store-origin-facts.js";
import { fileGit } from "./lib/store/laneCli.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hd-facts-"));

// A git seam over a fixed repository: `tree` maps path to text.
function fakeGit({ tree = {}, log = "", shallow = false, heads = "" } = {}) {
  return (args) => {
    if (args[0] === "ls-tree") return Object.keys(tree).join("\n");
    if (args[0] === "show") return tree[args[1].split(":")[1]];
    if (args[0] === "log") return log;
    if (args[0] === "rev-parse") return `${shallow}\n`;
    if (args[0] === "rev-list") return heads;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

describe("parseGitLog", () => {
  it("reads a header and its files, merge commits included", () => {
    const text = `${SHA_A} 2026-11-19T10:00:00+00:00\nscripts/a.js\n.github/workflows/x.yml\n\n${SHA_B} 2026-11-18T09:00:00Z\npackage.json\n`;
    expect(parseGitLog(text)).toEqual([
      { sha: SHA_A, committedAt: "2026-11-19T10:00:00+00:00", files: ["scripts/a.js", ".github/workflows/x.yml"] },
      { sha: SHA_B, committedAt: "2026-11-18T09:00:00Z", files: ["package.json"] },
    ]);
  });

  it("returns no commits for an empty log and refuses a log that starts with a file", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(() => parseGitLog("scripts/a.js\n")).toThrow(/not a commit header/);
  });
});

describe("writeFacts", () => {
  it("writes what fileGit requires, with absent markers and the empty pointer files", async () => {
    const out = tmp();
    const git = fakeGit({ tree: { "data/manifests/tel.json": "{\"x\":1}" }, log: `${SHA_A} 2026-11-19T10:00:00Z\nscripts/a.js\n`, heads: `${SHA_A}\n${SHA_B}\n` });
    const r = writeFacts({ out, slugs: ["tel", "zebec"], ref: "origin/main", head: "HEAD", since: "90 days ago", git });
    expect(r).toMatchObject({ manifests: 1, commits: 1, complete: true, heads: 2 });
    const seam = fileGit(out);
    expect(await seam.readManifest("tel")).toBe("{\"x\":1}");
    expect(await seam.readManifest("zebec")).toBeNull();
    expect(JSON.parse(await seam.readStoreFile())).toEqual({ schema: 1, releases: {} });
    expect(JSON.parse(fs.readFileSync(path.join(out, "manifests/site.json"), "utf8"))).toEqual({ schema: 1, root: null });
    expect(await seam.firstParentHistory()).toEqual({ commits: [{ sha: SHA_A, committedAt: "2026-11-19T10:00:00Z", files: ["scripts/a.js"] }], complete: true });
    expect(await seam.isAncestor(SHA_B)).toBe(true);
    expect(await seam.isAncestor("c".repeat(40))).toBe(false);
  });

  it("keeps the store.json and the index files main has, and says incomplete for a shallow checkout", () => {
    const out = tmp();
    const store = "{\"schema\":1,\"releases\":{\"live\":\"data-live-3\"}}";
    const git = fakeGit({ tree: { "data/manifests/store.json": store, "data/manifests/index/tel.json": "[]", "data/manifests/README.md": "x" }, shallow: true });
    writeFacts({ out, ref: "origin/main", head: "HEAD", since: "90 days ago", git });
    expect(fs.readFileSync(path.join(out, "manifests/store.json"), "utf8")).toBe(store);
    expect(fs.existsSync(path.join(out, "manifests/index/tel.json"))).toBe(true);
    expect(fs.existsSync(path.join(out, "manifests/README.md"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(out, "history.json"), "utf8")).complete).toBe(false);
    expect(fs.readFileSync(path.join(out, "head-commits.txt"), "utf8")).toBe("");
  });
});

describe("slugsFromCandidates", () => {
  it("lists the coins of every candidate and skips files that are not candidates", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "c1.json"), JSON.stringify({ coins: { tel: {}, zebec: {} } }));
    fs.writeFileSync(path.join(dir, "c2.json"), JSON.stringify({ coins: { tel: {} } }));
    fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
    expect(slugsFromCandidates(dir)).toEqual(["tel", "zebec"]);
    expect(slugsFromCandidates(path.join(dir, "missing"))).toEqual([]);
  });
});
