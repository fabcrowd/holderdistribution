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
 * Enabled only for the rebase in scripts/push-main.sh, which passes the
 * attribute and the driver with `git -c` (no git config or .gitattributes
 * change), so every other merge keeps git's normal line merge.
 */
import fs from "node:fs";
import process from "node:process";
import { mergeRpcUsage3 } from "./lib/rpcUsageMerge.js";

const [basePath, oursPath, theirsPath] = process.argv.slice(2);
if (!basePath || !oursPath || !theirsPath) {
  console.error("usage: merge-rpc-usage.js <base> <current> <other>");
  process.exit(2);
}

const read = (p) => {
  const text = fs.readFileSync(p, "utf8");
  return text.trim() === "" ? null : JSON.parse(text);
};

try {
  const merged = mergeRpcUsage3(read(basePath), read(oursPath), read(theirsPath));
  fs.writeFileSync(oursPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.error("[merge-rpc-usage] merged rpc-usage.json counters from both sides");
  process.exit(0);
} catch (err) {
  console.error(`[merge-rpc-usage] cannot merge: ${err.message}`);
  process.exit(1);
}
