#!/usr/bin/env node
/**
 * git merge driver for rpc-usage.json files:
 *
 *   node scripts/merge-rpc-usage.js <base %O> <current %A> <other %B>
 *
 * Writes the three-way counter merge of scripts/lib/rpcUsageMerge.js into the
 * %A file and exits 0. Exits 1 (git then records a conflict and leaves %A
 * untouched) when a version is not valid JSON or not an rpc-usage file, so
 * scripts/push-main.sh aborts the rebase as before.
 *
 * Also, used by scripts/push-main.sh after (and before) the rebase:
 *
 *   node scripts/merge-rpc-usage.js --from-git <base> <ours> <theirs> <out-dir>
 *
 * Walks every data/rpc-usage.json and data/<slug>/rpc-usage.json in the three
 * commits, writes the merged files under out-dir, and lists their repo paths
 * in out-dir/paths.txt. Git does not invoke the merge driver when both sides
 * made the identical edit, so the rebase alone can keep one increment; this
 * path recomputes from the three trees so the counters always sum. Exits 1
 * without guessing when a version is not an rpc-usage file.
 *
 * Enabled only from scripts/push-main.sh, which passes the attribute and the
 * driver with `git -c` (no git config or .gitattributes change), so every
 * other merge keeps git's normal line merge.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { mergeRpcUsage3 } from "./lib/rpcUsageMerge.js";

const USAGE_PATH = /^(data\/rpc-usage\.json|data\/[^/]+\/rpc-usage\.json)$/;

const readFile = (p) => {
  const text = fs.readFileSync(p, "utf8");
  return text.trim() === "" ? null : JSON.parse(text);
};

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

const listUsagePaths = (sha) =>
  git(["ls-tree", "-r", "--name-only", sha])
    .split("\n")
    .filter((p) => USAGE_PATH.test(p));

const readAt = (sha, rel) => {
  let text;
  try {
    text = git(["show", `${sha}:${rel}`]);
  } catch {
    return null;
  }
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${rel}: not valid JSON (${err.message})`);
  }
};

const mergeDriver = (basePath, oursPath, theirsPath) => {
  if (!basePath || !oursPath || !theirsPath) {
    console.error("usage: merge-rpc-usage.js <base> <current> <other>");
    process.exit(2);
  }
  const merged = mergeRpcUsage3(readFile(basePath), readFile(oursPath), readFile(theirsPath));
  fs.writeFileSync(oursPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.error("[merge-rpc-usage] merged rpc-usage.json counters from both sides");
};

const fromGit = (base, ours, theirs, outDir) => {
  if (!base || !ours || !theirs || !outDir) {
    console.error("usage: merge-rpc-usage.js --from-git <base> <ours> <theirs> <out-dir>");
    process.exit(2);
  }
  const paths = [...new Set([...listUsagePaths(base), ...listUsagePaths(ours), ...listUsagePaths(theirs)])].sort();
  fs.mkdirSync(outDir, { recursive: true });
  for (const rel of paths) {
    let merged;
    try {
      merged = mergeRpcUsage3(readAt(base, rel), readAt(ours, rel), readAt(theirs, rel));
    } catch (err) {
      console.error(`[merge-rpc-usage] cannot merge ${rel}: ${err.message}`);
      process.exit(1);
    }
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }
  fs.writeFileSync(path.join(outDir, "paths.txt"), paths.length ? `${paths.join("\n")}\n` : "", "utf8");
};

try {
  if (process.argv[2] === "--from-git") {
    fromGit(...process.argv.slice(3));
  } else {
    mergeDriver(...process.argv.slice(2));
  }
} catch (err) {
  console.error(`[merge-rpc-usage] cannot merge: ${err.message}`);
  process.exit(1);
}
