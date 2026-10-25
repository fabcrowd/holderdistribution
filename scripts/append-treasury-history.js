#!/usr/bin/env node
/**
 * append-treasury-history.js
 *
 * Keeps public/data/treasury-history.json current. The historical series is
 * built once by backfill-treasury-history.js (a Transfer-log replay); this
 * appends one dated entry per pipeline run so it does not go stale.
 *
 * Source is supply-reconciliation.json's `categories`, which reconcile-supply.js
 * has already computed from today's holder snapshot — so this needs no RPC, no
 * secrets, and no second definition of what counts as treasury. Run it directly
 * after reconcile-supply.js.
 *
 * COMPLETENESS GUARD. supply-reconciliation.json derives from tel-holders.json's
 * `wallets[]`, which contains only addresses with a recorded balance — an
 * address holding nothing is simply absent, and absent is indistinguishable
 * from zero. That is harmless for a total (the missing ones contribute 0) but
 * would be silent corruption if a category vanished wholesale, so a category
 * that is missing or non-finite aborts the run rather than writing a zero that
 * renders as the treasury being emptied.
 *
 * Usage: node scripts/append-treasury-history.js [--dry-run]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("append-treasury-history");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECONCILIATION_PATH = path.resolve(ROOT, "public/data/supply-reconciliation.json");
const HISTORY_PATH = path.resolve(ROOT, "public/data/treasury-history.json");
const HOLDERS_PATH = path.resolve(ROOT, "public/data/tel-holders.json");

const CATEGORIES = ["treasury", "council", "holdings", "escrow"];
const DRY_RUN = process.argv.includes("--dry-run");

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

const main = async () => {
  const history = await readJson(HISTORY_PATH).catch(() => null);
  if (!history?.entries?.length) {
    console.error(
      `${HISTORY_PATH} is missing or empty. Run scripts/backfill-treasury-history.js first —\n` +
        `appending to nothing would create a series that starts today and looks like the\n` +
        `treasury sprang into existence.`,
    );
    process.exit(1);
  }

  const reconciliation = await readJson(RECONCILIATION_PATH);

  // Date the entry by the snapshot the balances actually came from, not by
  // "now" — a run at 00:10 UTC would otherwise label yesterday's scan as today.
  const holders = await readJson(HOLDERS_PATH).catch(() => null);
  const date = (holders?.generatedAt ?? new Date().toISOString()).slice(0, 10);

  const categories = {};
  for (const key of CATEGORIES) {
    const value = Number(reconciliation.categories?.[key]);
    if (!Number.isFinite(value)) {
      console.error(
        `Category "${key}" is missing or non-finite in supply-reconciliation.json. Refusing to\n` +
          `write — a zero here renders as the whole bucket being emptied overnight.`,
      );
      process.exit(1);
    }
    categories[key] = Math.round(value);
  }

  const existingIndex = history.entries.findIndex((e) => e.date === date);
  const isUpdate = existingIndex >= 0;
  const previous = isUpdate ? history.entries[existingIndex] : history.entries[history.entries.length - 1];

  // Loud on implausible single-day swings. Not a hard failure — the treasury
  // genuinely does move in large steps (it is down 900M across 2026) — but a
  // 50% jump is worth seeing in the run log rather than discovering on a chart.
  for (const key of CATEGORIES) {
    const before = Number(previous?.categories?.[key]);
    if (!Number.isFinite(before) || before === 0) continue;
    const change = Math.abs(categories[key] - before) / before;
    if (change > 0.5) {
      console.warn(
        `  WARNING ${key}: ${(before / 1e9).toFixed(3)}B -> ${(categories[key] / 1e9).toFixed(3)}B ` +
          `(${(change * 100).toFixed(1)}% in one entry) — verify before trusting.`,
      );
    }
  }

  const entry = { date, categories };
  if (isUpdate) history.entries[existingIndex] = entry;
  else history.entries.push(entry);
  history.entries.sort((a, b) => a.date.localeCompare(b.date));
  history.generatedAt = new Date().toISOString();

  console.log(
    `${isUpdate ? "Updated" : "Appended"} ${date}: ` +
      CATEGORIES.map((c) => `${c} ${(categories[c] / 1e9).toFixed(3)}B`).join(", "),
  );

  if (DRY_RUN) {
    console.log("--dry-run: nothing written.");
    return;
  }
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  console.log(`Wrote ${HISTORY_PATH} (${history.entries.length} entries).`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
