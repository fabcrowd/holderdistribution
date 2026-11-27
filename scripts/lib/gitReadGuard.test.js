import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Past versions of data files are read only through stateStore.js, so another store can answer the same
// questions later. A non-test file under scripts/ that runs git through child_process must be listed here,
// and a workflow `run:` step that reads git history (git show / log / cat-file) must be listed below.
//
// What this guard does not see: a command string built at runtime (scripts/onboard-check.js runs
// `[gate.cmd, ...gate.args].join(" ")` through a shell), git run by a tool this code spawns (npm, gh, a shell
// script), and code outside scripts/ and the workflow run steps.
const repo = path.resolve(import.meta.dirname, "..", "..");
const SOURCE = /\.(?:js|mjs|cjs)$/;
const CHILD_PROCESS_IMPORT =
  /from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)|import\(\s*["'](?:node:)?child_process["']\s*\)/;
// A "git" command string: execFileSync("git", ...), spawnSync('git', ...), execSync(`git log ...`), const cmd = "git".
const GIT_COMMAND = /["'`]git(?:["'`]|\s)/;

// file (repo-relative, forward slashes) -> why it may call git itself.
const ALLOWED = new Map([
  ["scripts/lib/stateStore.js", "the read call for past versions of data files"],
  ["scripts/write-pipeline-status.js", "last commit time of each feed; moved by a later step"],
  ["scripts/onboard-run.js", "onboarding branch, commit and push; not a data read"],
  ["scripts/change-receipt.js", "diff and status for the change receipt; not a data read"],
  ["scripts/store-origin-facts.js", "the workflow's origin/main seam for the store CLIs (data/manifests and the stale-code guard's commit list); not a data read"],
  ["scripts/merge-rpc-usage.js", "three-way rpc-usage.json counter recompute during push-main.sh rebase (base/ours/theirs); not a store data read"],
]);

const walk = (dir) => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (SOURCE.test(entry.name) && !/\.(?:test|datacheck)\.[cm]?js$/.test(entry.name)) out.push(full);
  }
  return out;
};

/** Source with block comments and whole-line comments removed: a mention in prose is not a call. */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

const callsGit = (text) => {
  const code = withoutComments(text);
  return CHILD_PROCESS_IMPORT.test(code) && GIT_COMMAND.test(code);
};

describe("callsGit", () => {
  it("flags child_process git calls in each form", () => {
    expect(callsGit('import { execFileSync } from "node:child_process";\nexecFileSync("git", ["log"]);')).toBe(true);
    expect(callsGit("import { spawnSync } from 'child_process';\nspawnSync('git', ['show']);")).toBe(true);
    expect(callsGit('import { execSync } from "node:child_process";\nexecSync(`git log -1`);')).toBe(true);
    expect(callsGit('const cp = require("child_process");\nconst cmd = "git";')).toBe(true);
    expect(callsGit('const { execFileSync } = await import("node:child_process");\nexecFileSync("git", ["show"]);')).toBe(true);
    expect(callsGit("const cp = await import('child_process');\ncp.spawnSync('git', ['log']);")).toBe(true);
  });

  it("does not flag child_process use for other commands, or git named only in a comment", () => {
    expect(callsGit('import { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["x.js"]);')).toBe(false);
    expect(callsGit('import { spawnSync } from "node:child_process";\n// was execFileSync("git", ...)\nspawnSync("npm");')).toBe(false);
    expect(callsGit('const label = "git";')).toBe(false);
  });
});

describe("only stateStore.js reads git history in scripts/", () => {
  const files = walk(path.join(repo, "scripts"));
  const rel = (file) => path.relative(repo, file).split(path.sep).join("/");

  it("scans real source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no unlisted git caller", () => {
    const offenders = files.map(rel).filter((name) => !ALLOWED.has(name) && callsGit(fs.readFileSync(path.join(repo, name), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest: every entry exists and still calls git", () => {
    for (const [name] of ALLOWED) {
      const full = path.join(repo, name);
      expect(fs.existsSync(full), `${name} no longer exists; drop it from ALLOWED`).toBe(true);
      expect(callsGit(fs.readFileSync(full, "utf8")), `${name} no longer calls git; drop it from ALLOWED`).toBe(true);
    }
  });
});

// A git history read in a workflow shell step: `git show`, `git -C dir log`, `git --no-pager cat-file`.
const WORKFLOW_GIT_READ = /\bgit\b[^|;&\n]*?\s(?:show|log|cat-file)\b/;
// "<workflow file>: <trimmed run line>" -> why it may read git history. None exist today (2026-11-17).
const ALLOWED_WORKFLOW_READS = new Map();

/** Non-comment lines of the `run:` steps of one workflow file (single-line and block scalars). */
const runLines = (yaml) => {
  const out = [];
  let blockIndent = null;
  for (const line of yaml.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === "" || indent > blockIndent) {
        if (line.trim() && !line.trim().startsWith("#")) out.push(line.trim());
        continue;
      }
      blockIndent = null;
    }
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!run) continue;
    const value = run[2].trim();
    if (/^[|>][+-]?$/.test(value)) blockIndent = indent;
    else if (value && !value.startsWith("#")) out.push(value);
  }
  return out;
};

const workflowGitReads = (yaml) => runLines(yaml).filter((line) => WORKFLOW_GIT_READ.test(line));

describe("workflowGitReads", () => {
  it("finds git history reads in single-line and block run steps, not in comments or other keys", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: git log -1 --format=%cI -- x.json",
      "      - name: block",
      "        run: |",
      "          # git show HEAD:x.json in a comment",
      "          npm ci",
      "          git -C repo show HEAD:y.json > y.json",
      "      - name: after the block",
      "        with:",
      "          note: git log is mentioned outside a run step",
      "      - run: git add x.json && git commit -m 'update'",
    ].join("\n");
    expect(workflowGitReads(yaml)).toEqual(["git log -1 --format=%cI -- x.json", "git -C repo show HEAD:y.json > y.json"]);
  });
});

describe("workflow run steps read git history only where listed", () => {
  const dir = path.join(repo, ".github", "workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it("scans real workflow files and their run lines", () => {
    expect(files.length).toBeGreaterThan(5);
    const lines = files.flatMap((f) => runLines(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.some((line) => /^git commit\b/.test(line))).toBe(true);
  });

  it("has no unlisted git history read, and every listed one still exists", () => {
    const hits = files.flatMap((f) => workflowGitReads(fs.readFileSync(path.join(dir, f), "utf8")).map((line) => `${f}: ${line}`));
    expect(hits.filter((hit) => !ALLOWED_WORKFLOW_READS.has(hit))).toEqual([]);
    expect([...ALLOWED_WORKFLOW_READS.keys()].filter((hit) => !hits.includes(hit))).toEqual([]);
  });
});
