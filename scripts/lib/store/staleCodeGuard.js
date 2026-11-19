// The stale-code guard of design 2.1 section 9.4: a rerun of an old run must not mix old
// code with today's data. Let t be the start of this run attempt. Among the commits on main
// that touch `scripts`, `.github`, `package.json` or `package-lock.json` and are dated at or
// before t, none may be missing from the commit the job runs; the first (oldest) one that is
// missing is named in the refusal "run is older than the code on main".
//
// The caller's obligation. The guard is sound only when `commits` is the COMPLETE first-parent
// history of main for the guarded paths back to a bound the caller states and keeps (a date older
// than any run that may be rerun). The exact command, with the files each commit touches:
//   git log --first-parent --diff-merges=first-parent --name-only --format="%H %cI" //     --since=<bound> origin/main -- scripts .github package.json package-lock.json
// (%H the sha, %cI the committer date as an ISO time with a zone; the names that follow a header
// line are that commit's `files`.) It needs git 2.31 or newer: `--diff-merges=first-parent` is what
// gives a merge commit the files it brought in; older git (or a log without it) lists a merge
// commit with no files at all, so the merge reads as touching nothing and an old rerun passes.
// The path limit makes every listed commit touch a guarded path, so a listed commit with an empty
// `files` list is an input error here, never "touches nothing". Main's merges are squash or
// rebase merges or merge commits that carry the merge's own date. Then a merge commit is listed with
// its own date, and the commits of the merged branch (dated earlier, never ancestors of a run
// that started before the merge) are not listed. A caller that lists every parent (no
// --first-parent) would list those branch commits: they are dated before the attempt start and
// are not in the job's commit, so a current nightly would be stopped. That caller is wrong, not
// this guard. To make the obligation explicit the input must say `complete: true`; any other
// value is refused, so a caller that cut the list short cannot pass it silently.
// Two limits remain, both open to a wrong caller or a wrong clock rather than to this code: a
// committer clock set in the future lets an old rerun through until that date (the commit is
// not "due" before then), and a list the caller cut short while still saying complete lets it
// through.
//
// Pure over injected facts, so this module never runs git (gitReadGuard.test.js limits where
// a git read may live):
//   attemptStart  when this attempt started (a Date, or an ISO time with a zone)
//   complete      must be true: the caller states that `commits` is the complete first-parent list
//   commits       [{ sha, committedAt, files }] on main, with the files each one touches
//   isAncestor    (sha) => boolean | Promise<boolean>: is that commit in the job's commit
// Each commit carries its files and the path policy is applied here, so a seam that lists
// too many commits (a config-only onboarding push) cannot stop a run: config paths are never
// compared, because onboarding pushes config at any time. A commit dated after t never stops
// the run (a pull request merged during a long nightly). A commit with no `files` list is an
// input error, not an empty one: it could hide a code change.
//
// Cost by size: one `isAncestor` call per listed commit that touches a guarded path and is
// dated at or before t, until the first refusal. It grows with the commits the seam lists
// (the seam bounds them by date), never with N, H, C or D.
export const STALE_CODE_REASON = "run is older than the code on main";

const GUARDED_DIRS = ["scripts/", ".github/"];
const GUARDED_FILES = ["package.json", "package-lock.json"];
const SHA = /^[0-9a-f]{7,64}$/;
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export class StaleCodeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

export class StaleCodeError extends Error {
  constructor(message, commit) {
    super(message);
    this.name = new.target.name;
    this.commit = commit;
  }
}

export const touchesGuardedPath = (file) => GUARDED_FILES.includes(file) || GUARDED_DIRS.some((d) => file.startsWith(d));

function instant(value, at) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" && ZONED_TIME.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new StaleCodeInputError(`stale-code guard: ${at} must be a Date or an ISO time with a zone (2026-11-18T10:00:00Z), got ${JSON.stringify(value)}`);
  return ms;
}

function readCommit(c, i) {
  const at = `commits[${i}]`;
  if (c === null || typeof c !== "object") throw new StaleCodeInputError(`stale-code guard: ${at} must be an object { sha, committedAt, files }`);
  if (typeof c.sha !== "string" || !SHA.test(c.sha)) throw new StaleCodeInputError(`stale-code guard: ${at}.sha must be a lower-case hex commit id, got ${JSON.stringify(c.sha)}`);
  if (!Array.isArray(c.files) || c.files.some((f) => typeof f !== "string")) throw new StaleCodeInputError(`stale-code guard: ${at}.files must be a list of paths (a commit with no file list could hide a code change)`);
  if (c.files.length === 0) throw new StaleCodeInputError(`stale-code guard: ${at}.files is empty: the git command in the header lists only commits that touch a guarded path, so an empty list means the files of a merge commit were lost (git before 2.31, or no --diff-merges=first-parent)`);
  return { sha: c.sha, committedAt: c.committedAt, at: instant(c.committedAt, `${at}.committedAt`), guarded: c.files.some(touchesGuardedPath) };
}

function readArguments({ attemptStart, complete, commits, isAncestor }) {
  if (complete !== true) throw new StaleCodeInputError("stale-code guard: complete must be true: the caller must pass the complete first-parent history of main for the guarded paths since a bound it states, and say so");
  const start = instant(attemptStart, "attemptStart");
  if (!Array.isArray(commits)) throw new StaleCodeInputError("stale-code guard: commits must be a list");
  if (typeof isAncestor !== "function") throw new StaleCodeInputError("stale-code guard: isAncestor must be a function (sha) => boolean");
  return { start, list: commits.map(readCommit) };
}

// { ok: true, checked } or { ok: false, reason, commit: { sha, committedAt }, checked }.
export async function checkStaleCode(args) {
  const { start, list } = readArguments(args);
  const due = list.filter((c) => c.guarded && c.at <= start).sort((a, b) => a.at - b.at || (a.sha < b.sha ? -1 : 1));
  let checked = 0;
  for (const c of due) {
    const answer = await args.isAncestor(c.sha);
    if (typeof answer !== "boolean") throw new StaleCodeInputError(`stale-code guard: isAncestor(${c.sha}) must answer true or false, got ${JSON.stringify(answer)}`);
    checked++;
    if (!answer) return { ok: false, reason: STALE_CODE_REASON, commit: { sha: c.sha, committedAt: c.committedAt }, checked };
  }
  return { ok: true, checked };
}

// For a job that stops on a refusal.
export async function assertCodeCurrent(args) {
  const result = await checkStaleCode(args);
  if (!result.ok) {
    throw new StaleCodeError(`${result.reason}: commit ${result.commit.sha} (committed ${result.commit.committedAt}) is on main and is not in the commit this job runs`, result.commit);
  }
  return result;
}
