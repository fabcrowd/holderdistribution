#!/usr/bin/env node
/**
 * store-compare.js: design 2.1 section 9.2 step 4, while git still holds the files (dual-write). For each coin the
 * publish accepted, compares the sha256 of every file its lane generated (the candidate's `files`) with the same
 * file restored from the store.
 *
 *   node scripts/store-compare.js --kind <holders|ledger|walletFlows> --candidates-dir <dir> --restored-dir <dir>
 *     --published-dir <dir> --issues-out <file>
 *
 * --published-dir is store-publish's --out-dir (a coin is accepted when it holds manifests/<slug>.json);
 * --restored-dir is store-restore's --out-dir for those coins. A difference is reported as an `error` issue in
 * --issues-out ({ schema: 1, kind, phase: "compare", issues }); this script never fails the git path: exit code 0
 * whenever the comparison ran (mismatches or not), 1 when an input is bad, 2 for wrong arguments.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { KINDS } from "./lib/store/packNames.js";
import { LaneArgError, need, parseLaneArgs } from "./lib/store/laneCli.js";
import { parseCandidate, pickHighestAttempt } from "./lib/store/candidate.js";
import { safeJoin } from "./lib/store/laneRestore.js";
import { manifestSlugs, readCandidates, writeIssues } from "./lib/store/publishFiles.js";

const KNOWN = ["kind", "candidates-dir", "restored-dir", "published-dir", "issues-out"];
const SHOWN = 10;

const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

// expected: { <path>: <sha256> }; hashOf(path) -> sha256 | null (null: the restored file is missing).
// Returns the paths that differ: [{ path, expected, actual }].
export async function diffFiles(expected, hashOf) {
  const out = [];
  for (const [file, sha] of Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const actual = await hashOf(file);
    if (actual !== sha) out.push({ path: file, expected: sha, actual });
  }
  return out;
}

export function mismatchIssue(slug, kind, diffs, total) {
  const shown = diffs.slice(0, SHOWN).map((d) => `${d.path} (${d.actual === null ? "missing from the store" : `store ${d.actual.slice(0, 12)}, generated ${d.expected.slice(0, 12)}`})`);
  const more = diffs.length > SHOWN ? `, and ${diffs.length - SHOWN} more` : "";
  return { code: "store-file-mismatch", severity: "error", slug, title: `${kind} ${slug}: ${diffs.length} of ${total} files differ between the store and the generated files`, detail: `${shown.join("; ")}${more}` };
}

export async function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = parseLaneArgs(argv, KNOWN);
  need(args, KNOWN);
  if (!KINDS.includes(args.kind)) throw new LaneArgError(`--kind must be one of ${KINDS.join(", ")}`);
  const restored = path.resolve(args["restored-dir"]);
  const issues = [];
  try {
    const picked = pickHighestAttempt(readCandidates(args["candidates-dir"]).map((c) => parseCandidate(c.text)), args.kind);
    const accepted = fs.existsSync(path.join(args["published-dir"], "manifests")) ? manifestSlugs(args["published-dir"]) : [];
    let files = 0;
    for (const slug of accepted.filter((s) => picked.coins[s])) {
      const expected = picked.coins[slug].files;
      const hashOf = async (rel) => {
        const file = safeJoin(restored, rel, slug);
        return fs.existsSync(file) ? sha256File(file) : null;
      };
      const diffs = await diffFiles(expected, hashOf);
      files += Object.keys(expected).length;
      if (diffs.length > 0) issues.push(mismatchIssue(slug, args.kind, diffs, Object.keys(expected).length));
    }
    logger.log(`compare ${args.kind}: ${accepted.length} accepted coins, ${files} files compared, ${issues.length} coins with differences`);
    for (const i of issues) logger.error(`  ${i.title}`);
  } catch (err) {
    writeIssues(args["issues-out"], { schema: 1, kind: args.kind, phase: "compare", issues: [{ code: "crash", severity: "error", slug: null, title: "store-compare crashed; the restored files were not compared", detail: `${err.name}: ${err.message}` }] });
    throw err;
  }
  writeIssues(args["issues-out"], { schema: 1, kind: args.kind, phase: "compare", issues });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[store-compare] ${err.message}`);
    process.exitCode = err instanceof LaneArgError ? 2 : 1;
  });
}
