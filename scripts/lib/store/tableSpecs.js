// The table specs of the lane for every registered coin (the `--table-specs` module of store-pack.js and
// store-restore.js; the spec interface is in laneTables.js). Driven by the registry, with no coin or chain
// name here: a coin gets the specs of the files its registry entry says it produces
// (workflowPlan's HD_REQUIRED_FILES, the feeds the nightly verify step requires of every coin), at the path
// the coin's layout gives (layout.dataDir, itself read from config/projects/<slug>.json). A coin whose
// required files do not include a table's file gets no spec for it; a file with no format stays a blob.
//
// Registered today: the ever-held list (tableFormats.js). Not registered, with the reason (the formats
// cannot rebuild the file byte for byte, or the spec cannot name it): tableFormats.js header.
//
// rowsPerBucket R = 262,144 (design 3.1: a bucket averages R rows and holds at most about 2R). The ever-held
// list is 14 bytes a row as text for a 0.0.n account, 44 for hex and 45 for base58, so one bucket is 3.5 to
// 12 MiB of text and 100 MB in memory at 2R at most. Cost by size, H rows: buckets B = 1 for H up to R, 4 at
// 1 million, 19 at 4.84 million, 39 at 10 million, 382 at 100 million (design 3.1); a night's work is one
// read of the file, one spool pass and the change rows (an address is added once, so a night's change rows
// are the new holders, 50 bytes each: design 2); a restore writes the file from the buckets in one merge of
// B runs (two passes above 64 buckets); memory one bucket at a time (tableFormats.js header).
import { loadRegistry, resolveProject } from "../projects.js";
import { workflowPlan } from "../../workflow-paths.js";
import { EVER_SET_FIELDS, everSetFormat } from "./tableFormats.js";

export const ROWS_PER_BUCKET = 262_144;

// A table format's file and spec parameters. `file` is the feed's file name in the coin's data directory.
export const TABLE_FILES = Object.freeze([
  { table: "everHeld", file: "holders-ever-checkpoint.json", fields: EVER_SET_FIELDS, format: everSetFormat },
]);

// The pure part: the specs of a coin whose data directory is `dataDir` and whose required files are `requiredFiles`.
export function specsFor({ dataDir, requiredFiles }) {
  return TABLE_FILES
    .filter((t) => requiredFiles.includes(t.file))
    .map((t) => ({ table: t.table, path: `${dataDir}/${t.file}`, fields: t.fields, rowsPerBucket: ROWS_PER_BUCKET, format: t.format }));
}

// slug: a registered coin (config/projects.json; an unknown slug throws, as every registry reader does).
export function tableSpecsFor(slug, layout, root = process.cwd()) {
  if (!loadRegistry(root).some((p) => p.slug === slug)) throw new Error(`table specs: unknown project "${slug}" (config/projects.json)`);
  const project = resolveProject(slug, root);
  return specsFor({ dataDir: layout.dataDir, requiredFiles: workflowPlan(project, root).HD_REQUIRED_FILES.split(/\s+/).filter(Boolean) });
}
