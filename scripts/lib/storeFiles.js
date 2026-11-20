// The files each kind of run stores for a coin (design 2.1 section 7.3) and the files it never
// stores (section 13). Pure over a directory tree: no registry read, no coin or chain name; the
// caller gives the coin's layout from the registry (coinLayout).
//
// Directories per kind. P is the coin's public data directory and W its working directory:
//   holders      P, and W except the ledger and forensics directories
//   ledger       the ledger directory
//   walletFlows  the forensics directory
// The ledger and forensics directories are named by the caller because a coin on shared roots keeps
// its ledger beside, not under, W (ledgerOutRelDir). On shared roots (a coin whose P and W are the parent of other coins' directories) P and W are shared with
// the other coins: their registered slugs are `siblings`, directories to skip.
//
// Excluded (never stored, whatever the kind): only files that are not generated state: scratch
// copies (`*-previous.json`, and the sharded `*-previous.d/` directory), `.gitkeep`, files kept by
// hand and review queues. The exclusion paths are relative to W, or to P for the scratch and
// `.gitkeep` patterns that apply in both.
//
// A file the lane cannot store faithfully is an error, not a skip (UnclassifiedFileError): one that
// is not a regular file, one whose path holds a character a restore cannot write back, one
// that uses the reserved slice marker of a stored blob, and a directory in a coin's own tree named like
// another registered coin (a misplaced file would otherwise be stored under the wrong coin).
// Cost: one directory walk, memory one directory listing at a time; the listing returned holds one
// path per file.
import fs from "node:fs/promises";
import path from "node:path";
import { SLICE_MARKER } from "./store/laneNames.js";

export class StoreFilesError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnclassifiedFileError extends StoreFilesError {
  constructor(files) {
    super(`store files: ${files.length} file(s) are neither stored nor excluded: ${files.map((f) => `${f.path} (${f.why})`).join("; ")}`);
    this.files = files;
  }
}

export const STORED_KINDS = ["holders", "ledger", "walletFlows"];
const PREVIOUS = /-previous\.json$/;
const PREVIOUS_DIR = /-previous\.d$/;
const UNSAFE_NAME = /[\\:*?"<>|\u0000-\u001f]|^\s|\s$/;

// Paths relative to W: hand-kept files and the two review queues (section 13).
export const EXCLUDED_WORK_FILES = Object.freeze([
  "unallocated-classification.json",
  "forensics/wallet-flows.registry.json",
  "cex-candidates.json",
  "cex-dune-candidates.json",
]);
export const EXCLUDED_BASENAMES = Object.freeze([".gitkeep"]);

const posix = (p) => p.split(path.sep).join("/");

const isRelative = (v) => typeof v === "string" && v !== "" && !v.startsWith("/") && !v.split("/").includes("..");

// dataDir / workDir are repo-relative (`public/data`, `data/<slug>`); ledgerDir and forensicsDir
// default to the directories below workDir. excludedFiles: the coin's own hand-kept files, relative
// to the root they are found under (W, as EXCLUDED_WORK_FILES), from the coin's registry config.
export function coinLayout({ slug, dataDir, workDir, sharedRoots = false, slugs = [], ledgerDir = `${workDir}/ledger`, forensicsDir = `${workDir}/forensics`, excludedFiles = [] }) {
  for (const [k, v] of Object.entries({ slug, dataDir, workDir, ledgerDir, forensicsDir })) {
    if (!isRelative(v)) throw new StoreFilesError(`store files: layout ${k} must be a repo-relative path, got ${JSON.stringify(v)}`);
  }
  if (!Array.isArray(excludedFiles) || !excludedFiles.every(isRelative)) throw new StoreFilesError(`store files: layout excludedFiles must be a list of repo-relative paths, got ${JSON.stringify(excludedFiles)}`);
  return Object.freeze({
    slug, dataDir, workDir, ledgerDir, forensicsDir, sharedRoots, excludedFiles: Object.freeze([...excludedFiles]),
    others: Object.freeze(slugs.filter((s) => s !== slug)), shared: sharedRoots ? Object.freeze([...slugs]) : Object.freeze([]),
  });
}

// The walk plans of one kind: { dir, kindOf(relativeDir) } where `own` says whether a directory below
// `dir` belongs to the kind.
export function kindRoots(layout, kind) {
  if (!STORED_KINDS.includes(kind)) throw new StoreFilesError(`store files: unknown kind ${JSON.stringify(kind)} (one of ${STORED_KINDS.join(", ")})`);
  if (kind === "ledger") return [{ dir: layout.ledgerDir, skip: [], root: layout.workDir }];
  if (kind === "walletFlows") return [{ dir: layout.forensicsDir, skip: [], root: layout.workDir }];
  const own = [layout.ledgerDir, layout.forensicsDir];
  const skipBelow = (dir) => [...layout.shared, ...own.filter((d) => path.posix.dirname(d) === dir).map((d) => path.posix.basename(d))];
  return [
    { dir: layout.dataDir, skip: skipBelow(layout.dataDir), root: layout.dataDir },
    { dir: layout.workDir, skip: skipBelow(layout.workDir), root: layout.workDir },
  ];
}

const isExcluded = (rel, relToRoot, layout) => {
  const base = path.posix.basename(rel);
  if (EXCLUDED_BASENAMES.includes(base) || PREVIOUS.test(base)) return true;
  return EXCLUDED_WORK_FILES.includes(relToRoot) || layout.excludedFiles.includes(relToRoot);
};

async function walk({ root, layout, plan, rel, out, problems }) {
  const abs = path.join(root, plan.dir, rel);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const here = rel === "" ? e.name : `${rel}/${e.name}`;
    const repoPath = `${plan.dir}/${here}`;
    if (UNSAFE_NAME.test(e.name) || e.name.includes(SLICE_MARKER)) problems.push({ path: repoPath, why: "name cannot be stored" });
    else if (e.isDirectory()) {
      if (rel === "" && plan.skip.includes(e.name)) continue;
      if (PREVIOUS_DIR.test(e.name)) continue;
      if (!layout.sharedRoots && layout.others.includes(e.name)) problems.push({ path: repoPath, why: "directory named like another registered coin" });
      else await walk({ root, layout, plan, rel: here, out, problems });
    } else if (!e.isFile()) problems.push({ path: repoPath, why: "not a regular file" });
    else out.push({ path: repoPath, excluded: isExcluded(here, posix(path.posix.relative(plan.root, repoPath)), layout) });
  }
}

// { files: [repo-relative path], excluded: [repo-relative path] } of one kind, sorted. Throws
// UnclassifiedFileError listing every file that could be neither stored nor excluded.
export async function listCoinFiles({ root, layout, kind }) {
  const out = [];
  const problems = [];
  for (const plan of kindRoots(layout, kind)) await walk({ root, layout, plan, rel: "", out, problems });
  if (problems.length > 0) throw new UnclassifiedFileError(problems);
  const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    files: out.filter((f) => !f.excluded).map((f) => f.path).sort(byPath),
    excluded: out.filter((f) => f.excluded).map((f) => f.path).sort(byPath),
  };
}
