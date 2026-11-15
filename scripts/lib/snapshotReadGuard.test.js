import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A holder snapshot may be a small head plus shard files, so a bare JSON.parse of it sees no `wallets` and
// silently publishes zeros. Every non-test file that names a snapshot file must read it through snapshotIo.js.
const repo = path.resolve(import.meta.dirname, "..", "..");
const SCAN_ROOTS = ["scripts", "netlify"];
const SOURCE = /\.(?:js|mjs|cjs)$/;
const SNAPSHOT_NAME = /tel-holders(?:-previous)?\.json/;
const SNAPSHOT_IO_IMPORT = /from\s+["'][^"']*snapshotIo\.js["']/;
// A git-history read of a snapshot that parses the blob itself (showJson(commit, SNAP_REL), JSON.parse(git show ...)).
const BARE_GIT_SNAPSHOT_READ = [
  /showJson\([^)]*(?:SNAP_REL|HOLDERS_SNAPSHOT_FILE|tel-holders)/,
  /JSON\.parse\([^\n]*\bshow\b[^\n]*(?:SNAP_REL|HOLDERS_SNAPSHOT_FILE|tel-holders)/,
];

// file (repo-relative, forward slashes) -> why it may name a snapshot file without importing snapshotIo.js.
const ALLOWED = new Map([
  ["scripts/scan-hedera-flows.js", "git log on the path, dates only (firstSnapshotDate)"],
  ["scripts/scan-solana-flows.js", "git log on the path, dates only (firstSnapshotDate)"],
  ["scripts/workflow-paths.js", "file-name list of required outputs, existence check only"],
  ["scripts/lib/onboardRun.js", "existence check on the file list and fix-it message text; the snapshot itself is read in onboard-run.js"],
  ["scripts/lib/cex-write-and-flows.js", "dead file, not imported: reads and writes the snapshot with its own helpers"],
]);

const walk = (dir) => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (SOURCE.test(entry.name) && !/\.test\.[cm]?js$/.test(entry.name)) out.push(full);
  }
  return out;
};

/** Source with block comments and whole-line comments removed: a mention in prose is not a read. */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** Problems for one file's text: a snapshot name without the snapshotIo import, and bare git snapshot reads. */
const snapshotReadProblems = (text) => {
  const code = withoutComments(text);
  const problems = [];
  if (SNAPSHOT_NAME.test(code) && !SNAPSHOT_IO_IMPORT.test(code)) problems.push("names a holder snapshot file but does not import snapshotIo.js");
  for (const pattern of BARE_GIT_SNAPSHOT_READ) {
    if (pattern.test(code)) problems.push("parses a git-shown holder snapshot itself; use readSnapshotAtRev");
  }
  return problems;
};

describe("snapshotReadProblems", () => {
  it("flags a bare read of the snapshot", () => {
    expect(snapshotReadProblems('const x = JSON.parse(fs.readFileSync(data("tel-holders.json"), "utf8"));')).toHaveLength(1);
    expect(snapshotReadProblems('const p = "public/data/tel-holders-previous.json";')).toHaveLength(1);
  });

  it("accepts a file that imports snapshotIo.js", () => {
    const text = 'import { readSnapshot } from "./lib/snapshotIo.js";\nconst f = data("tel-holders.json");';
    expect(snapshotReadProblems(text)).toEqual([]);
  });

  it("ignores a mention in a comment", () => {
    expect(snapshotReadProblems("// reads tel-holders.json\n/* the tel-holders.json\n   snapshot */\nconst a = 1;")).toEqual([]);
  });

  it("flags a bare git-show parse of the snapshot even when snapshotIo.js is imported", () => {
    const text = 'import { readSnapshot } from "./lib/snapshotIo.js";\nconst snap = showJson(commit, SNAP_REL);';
    expect(snapshotReadProblems(text)).toEqual(["parses a git-shown holder snapshot itself; use readSnapshotAtRev"]);
  });

  it("does not flag showJson of another file", () => {
    expect(snapshotReadProblems("const fund = showJson(commit, FUND_REL);")).toEqual([]);
  });
});

describe("every reader of a holder snapshot goes through snapshotIo.js", () => {
  const files = SCAN_ROOTS.flatMap((root) => walk(path.join(repo, root)));
  const rel = (file) => path.relative(repo, file).split(path.sep).join("/");

  it("scans real source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no unreviewed reader", () => {
    const offenders = [];
    for (const file of files) {
      const name = rel(file);
      if (ALLOWED.has(name)) continue;
      for (const problem of snapshotReadProblems(fs.readFileSync(file, "utf8"))) offenders.push(`${name}: ${problem}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest: every entry exists and still names a snapshot file", () => {
    for (const [name] of ALLOWED) {
      const full = path.join(repo, name);
      expect(fs.existsSync(full), `${name} no longer exists; drop it from ALLOWED`).toBe(true);
      expect(SNAPSHOT_NAME.test(withoutComments(fs.readFileSync(full, "utf8"))), `${name} no longer names a snapshot file; drop it from ALLOWED`).toBe(true);
    }
  });
});
