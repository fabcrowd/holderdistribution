/**
 * Read calls for past versions of data files: the dates a version exists for, and a file's content as of
 * a date or a revision. Backed by git history for now; the only place in scripts/ that reads data out of
 * git history, so another store can answer the same questions later without touching the callers.
 *
 * `file` is always repo-relative (projectPaths(project).rel(...)), so it already names the project.
 */

import { execFileSync } from "node:child_process";
import { parseSnapshotFrom } from "./snapshotIo.js";

const MIB = 1024 * 1024;
const DEFAULT_MAX_BUFFER = 512 * MIB;
const QUIET_STDIO = ["ignore", "pipe", "pipe"];

// stdio is passed only where the old caller passed it: a bare call lets git's stderr reach the console, as before.
const git = (args, { cwd = process.cwd(), maxBuffer = DEFAULT_MAX_BUFFER, encoding = "utf8", stdio } = {}) =>
  execFileSync("git", args, { cwd, maxBuffer, encoding, ...(stdio ? { stdio } : {}) });

/**
 * Newest revision per date (author date, YYYY-MM-DD) of `file`, as a Map in newest-first order.
 * Dates with no version are absent; callers sort the keys when they need them ascending.
 */
export const versionsByDate = (file, opts = {}) => {
  const out = git(["log", "--format=%H %ad", "--date=short", "--", file], opts);
  const map = new Map();
  for (const line of out.trim().split("\n")) {
    const [rev, date] = line.split(" ");
    if (rev && date && !map.has(date)) map.set(date, rev);
  }
  return map;
};

/**
 * Latest revision of `file` committed on or before the end of `date` (committer date, local time), or ""
 * when there is none. A different rule from versionsByDate: kept as readCommittedJson has always used it.
 */
export const revisionAsOf = (file, date, opts = {}) =>
  git(["log", "--format=%H", "-1", `--until=${date} 23:59:59`, "--", file], opts).trim();

/** Text of `file` at `rev`. */
export const readTextAt = (rev, file, opts = {}) => git(["show", `${rev}:${file}`], opts);

/** `file` at `rev`, parsed as JSON. */
export const readJsonAt = (rev, file, opts = {}) => JSON.parse(readTextAt(rev, file, opts));

/** A holder snapshot at `rev` in any layout; a sharded head is assembled from the shard files at the same rev. */
export const readSnapshotAtRev = (rev, repoRelPath, { cwd = process.cwd(), maxBuffer = DEFAULT_MAX_BUFFER } = {}) => {
  const show = (path, encoding) => git(["show", `${rev}:${path}`], { cwd, maxBuffer, encoding, stdio: QUIET_STDIO });
  return parseSnapshotFrom(repoRelPath, show(repoRelPath, "utf8"), (shardPath) => show(shardPath, null));
};
