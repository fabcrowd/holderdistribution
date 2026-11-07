#!/usr/bin/env node
/**
 * Relabels holders-history rows written by rebuild-history-from-logs.js
 * before it adopted the end-of-day label. Those rows hold state at the last
 * block <= D 00:00:00Z (end of D-1) but were labelled date D with generatedAt
 * `${D}T00:00:00.000Z`. This moves each one to date D-1 / `${D-1}T23:59:59.000Z`.
 *
 * Usage: node scripts/relabel-midnight-history.js --project <slug> [--apply]
 * Dry-run by default. Idempotent: relabelled rows end at 23:59:59, so a second
 * run matches nothing. Rows with a `settled` or `asOf` marker are never touched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DAY_MS = 86_400_000;

/** Previous UTC calendar day of "YYYY-MM-DD". */
export const previousDay = (date) => new Date(Date.parse(`${date}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);

/** Label for a snapshot taken at the D 00:00Z boundary: it is end-of-(D-1) state. */
export const endOfDayLabel = (boundaryDate) => {
  const date = previousDay(boundaryDate);
  return { date, generatedAt: `${date}T23:59:59.000Z` };
};

const isMidnightRow = (row) =>
  typeof row?.date === "string"
  && row.generatedAt === `${row.date}T00:00:00.000Z`
  && !("settled" in row)
  && !("asOf" in row);

/**
 * Pure. Returns { entries, relabelled, collisions } without mutating input.
 * A relabelled row whose D-1 is already held by a row that is not itself being
 * relabelled is dropped (the existing row wins) and reported in `collisions`.
 */
export const relabelMidnightEntries = (entries) => {
  const list = Array.isArray(entries) ? entries : [];
  const keptDates = new Set(list.filter((r) => !isMidnightRow(r)).map((r) => r.date));
  const collisions = [];
  let relabelled = 0;
  const out = [];
  for (const row of list) {
    if (!isMidnightRow(row)) { out.push(row); continue; }
    const label = endOfDayLabel(row.date);
    if (keptDates.has(label.date)) { collisions.push({ from: row.date, to: label.date }); continue; }
    out.push({ ...row, ...label });
    relabelled += 1;
  }
  const byDate = new Map();
  for (const row of out) if (!byDate.has(row.date)) byDate.set(row.date, row);
  const sorted = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { entries: sorted, relabelled, collisions };
};

const brief = (rows) => rows.map((r) => `${r.date} ${r.generatedAt}`).join("\n    ");

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--project");
  const slug = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--project="))?.slice(10);
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("--project <slug> is required");
  const apply = args.includes("--apply");
  const file = path.join(process.cwd(), "public", "data", slug, "holders-history.json");
  const raw = await fs.readFile(file, "utf8");
  const doc = JSON.parse(raw);
  const before = doc.entries ?? [];
  const { entries, relabelled, collisions } = relabelMidnightEntries(before);
  console.log(`${file}`);
  console.log(`  before: ${before.length} rows\n    first: ${brief(before.slice(0, 3))}\n    last:  ${brief(before.slice(-3))}`);
  console.log(`  after:  ${entries.length} rows (relabelled ${relabelled}, collisions ${collisions.length})\n    first: ${brief(entries.slice(0, 3))}\n    last:  ${brief(entries.slice(-3))}`);
  for (const c of collisions) console.log(`  collision: ${c.from} -> ${c.to} kept existing row`);
  if (!apply) { console.log("  dry-run: nothing written (pass --apply)."); return; }
  if (relabelled === 0 && collisions.length === 0) { console.log("  nothing to change."); return; }
  await fs.writeFile(file, `${JSON.stringify({ ...doc, entries }, null, 2)}\n`, "utf8");
  console.log("  written.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
