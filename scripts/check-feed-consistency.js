#!/usr/bin/env node
/**
 * check-feed-consistency.js
 *
 * Cross-feed gate: asserts that every quantity carried by more than one
 * artifact agrees, and that derived copies are in sync with their source.
 *
 * WHY THIS EXISTS
 *
 * validate-outputs.js checks that each file exists and has the right KEYS. It
 * cannot catch the failure that actually happens, which is every file being
 * individually well-formed while disagreeing with its neighbours. On
 * 2026-08-29 a five-address reclassification left `tel-holders.json` and
 * `holders-summary.json` reporting 67,843,742,873 retail while
 * `holders-lite.json`, `holders-history.json` and `supply-reconciliation.json`
 * reported 66,093,742,873, and `treasury-history.json`'s escrow sat exactly
 * 1,750,000,000 below the pie it is drawn beside. Every file passed shape
 * validation. Nothing failed. The site served both numbers on one page.
 *
 * The rule this encodes, from lessons.md: "Two Counts of the Same Thing on One
 * Page Must Reconcile By Construction" — and where construction cannot
 * guarantee it, a gate must.
 *
 * Exit 1 on any mismatch, so a pipeline run fails BEFORE committing rather
 * than publishing a self-contradicting dataset.
 *
 * Run: node scripts/check-feed-consistency.js [--project <slug> | --all] [--strict]
 *   --strict also fails on staleness warnings (feeds more than STALE_DAYS old).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { selectPipelineProject, projectPaths, projectClassificationPath } from "./lib/projects.js";
import { holderDayChanges, placeholderLag, resolveConsistencyOptions, resolveFeedHealth, runForEachProject, seriesBreakDates } from "./lib/feedHealth.js";

// `--all`: once per registered project; fail if any project fails.
if (process.argv.includes("--all")) {
  const failed = runForEachProject(import.meta.url, process.argv.slice(2).filter((a) => a !== "--all"));
  if (failed > 0) console.error(`
${failed} project(s) failed the consistency check.`);
  process.exit(failed > 0 ? 1 : 0);
}

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: checks the
// project's data dir (TEL: public/data/, others: public/data/<slug>/) against
// its own classification changelog and treasury categories.
const project = selectPipelineProject("check-feed-consistency", { ported: true });

const ROOT = process.cwd();
const DATA = projectPaths(project, ROOT).dir;
const DATA_REL = project.dataDir;
const CHANGELOG_PATH = projectClassificationPath(project, "changelog", ROOT);
const CHANGELOG_REL = CHANGELOG_PATH ? path.relative(ROOT, CHANGELOG_PATH).split(path.sep).join("/") : "(none declared)";
// Same category set as append-treasury-history.js (shared panel format).
const TREASURY_CATEGORIES = project.config?.treasury?.categories ?? ["treasury", "council", "holdings", "escrow"];
const strict = process.argv.includes("--strict");

/** Absolute TEL tolerance. Feeds round differently at the sub-TEL level. */
const TOLERANCE = 1;
const STALE_DAYS = 3;

const failures = [];
const warnings = [];
const checks = [];

const read = async (rel, { optional = false } = {}) => {
  try {
    return JSON.parse(await fs.readFile(path.resolve(DATA, rel), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && optional) return null;
    throw error;
  }
};

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : String(n));

/** Assert every named source reports the same value. */
const agree = (label, entries) => {
  const present = entries.filter(([, v]) => Number.isFinite(v));
  if (present.length < 2) {
    warnings.push(`${label}: only ${present.length} source(s) available — nothing to cross-check`);
    return;
  }
  const [, first] = present[0];
  const bad = present.filter(([, v]) => Math.abs(v - first) > TOLERANCE);
  if (bad.length > 0) {
    failures.push(
      `${label} DISAGREES across feeds:\n` +
        present.map(([name, v]) => `      ${name.padEnd(38)} ${fmt(v).padStart(18)}`).join("\n"),
    );
  } else {
    checks.push(`${label}: ${present.length} feeds agree at ${fmt(first)}`);
  }
};

const lastEntry = (doc) => {
  const list = doc?.entries;
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
};

const main = async () => {
  const supply = await read("supply-reconciliation.json");
  const lite = await read("holders-lite.json");
  const summary = await read("holders-summary.json");
  const holders = await read("tel-holders.json");
  const history = await read("holders-history.json");
  const treasury = await read("treasury-history.json", { optional: true });

  // --- 1. Retail balance. Four feeds carry it; on 2026-08-29 two were stale.
  const histLast = lastEntry(history);
  agree("retail balance", [
    ["supply-reconciliation.categories.retail", supply?.categories?.retail],
    ["holders-lite.views.combined", lite?.views?.combined?.metrics?.totalBalance],
    ["holders-summary.combined", summary?.combined?.totalBalance],
    ["tel-holders.combined", holders?.combined?.totalBalance],
    [`holders-history[${histLast?.date}]`, histLast?.combined?.totalBalance],
  ]);

  // --- 2. Holder count, same set of feeds.
  agree("holder count", [
    ["holders-lite.views.combined", lite?.views?.combined?.metrics?.holderCount],
    ["holders-summary.combined", summary?.combined?.holderCount],
    ["tel-holders.combined", holders?.combined?.holderCount],
    [`holders-history[${histLast?.date}]`, histLast?.combined?.holderCount],
  ]);

  // --- 3. Every treasury-history category against the pie it renders beside.
  // This is the check that catches an append-treasury-history.js that did not
  // re-run after reconcile-supply.js.
  const tLast = lastEntry(treasury);
  if (tLast) {
    for (const key of TREASURY_CATEGORIES) {
      agree(`category "${key}"`, [
        ["supply-reconciliation.categories", supply?.categories?.[key]],
        [`treasury-history[${tLast.date}]`, tLast.categories?.[key]],
      ]);
    }
  }

  // --- 4. Categories must sum to `counted`.
  const catSum = Object.values(supply?.categories ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  if (Number.isFinite(supply?.counted) && Math.abs(catSum - supply.counted) > TOLERANCE) {
    failures.push(`supply categories sum ${fmt(catSum)} != counted ${fmt(supply.counted)}`);
  } else {
    checks.push(`supply categories sum to counted (${fmt(catSum)})`);
  }

  // --- 5. The served changelog must match the hand-curated config. The app
  // fetches public/data/; editing config/ alone leaves the UI showing no
  // reclassification marker, silently, with no error anywhere.
  // A non-legacy project that declares no changelog has no events (never TEL's).
  const cfgLog = CHANGELOG_PATH ? JSON.parse(await fs.readFile(CHANGELOG_PATH, "utf8")) : { events: [] };
  const pubLog = await read("classification-changelog.json", { optional: true });
  if (!pubLog) {
    failures.push(`${DATA_REL}/classification-changelog.json missing — run scripts/sync-classification-changelog.js`);
  } else {
    const cfgIds = (cfgLog.events ?? []).map((e) => e.id).sort();
    const pubIds = (pubLog.events ?? []).map((e) => e.id).sort();
    const missing = cfgIds.filter((id) => !pubIds.includes(id));
    const extra = pubIds.filter((id) => !cfgIds.includes(id));
    if (missing.length || extra.length) {
      failures.push(
        `classification-changelog ${CHANGELOG_REL} and ${DATA_REL}/ out of sync — run scripts/sync-classification-changelog.js` +
          (missing.length ? `\n      missing from served copy: ${missing.join(", ")}` : "") +
          (extra.length ? `\n      only in served copy: ${extra.join(", ")}` : ""),
      );
    } else {
      checks.push(`classification-changelog in sync (${cfgIds.length} events)`);
    }
  }

  // --- 6. Every changelog event must name metrics the UI actually queries,
  // and be dated at or before the archive's last entry. Both failure modes
  // render NO marker while looking perfectly valid in the JSON.
  const QUERIED = new Set(["retail.count", "retail.balance", "totalHeld", "cexBalance", "vault-unattributed"]);
  const archiveEnd = histLast?.date;
  for (const event of cfgLog.events ?? []) {
    if (event.backfillStatus === "complete") continue; // documentation only, renders nothing by design
    const metrics = event.affects?.metrics ?? [];
    if (!metrics.some((m) => QUERIED.has(m))) {
      failures.push(
        `changelog event "${event.id}" names no metric the UI queries (has: ${metrics.join(", ") || "none"}). ` +
          `Queried names: ${[...QUERIED].join(", ")}`,
      );
    }
    if (archiveEnd && event.date > archiveEnd) {
      warnings.push(
        `changelog event "${event.id}" is dated ${event.date}, after the archive's last entry ` +
          `(${archiveEnd}) — getEventsAffecting requires eventMs <= range end, so it renders no marker yet`,
      );
    }
  }

  // --- 7. Standing rule: a reclassification must ship with a backfill through
  // every historical data set, not just correct the day it was made. Without
  // this, a config edit alone produces a fake one-day step on the day someone
  // happened to touch a label file, instead of the flat line the unchanged
  // on-chain balances actually describe — see lessons.md, "Re-labelling Is
  // Not an Inflow — Backfill Prior CEX History", and the 2026-08-29 escrow
  // vault event this rule was written after.
  //
  // "complete" (backfilled) and "not-possible" (a permanent, documented
  // limitation — e.g. rebuild-history-from-logs.js's pre-2026-02-28 scan-floor
  // boundary) are both acceptable end states. Anything else is a reclassification
  // still owed a backfill. A short grace period (RECLASSIFICATION_GRACE_DAYS)
  // allows the commit that files the event and the commit that runs the
  // backfill to land as two separate, reviewable steps without instantly
  // failing every pipeline run in between — but it must not stay open.
  const RECLASSIFICATION_TYPES = new Set(["reclassification", "cex-relabel", "exclusion-add"]);
  const RESOLVED_BACKFILL_STATUSES = new Set(["complete", "not-possible"]);
  const RECLASSIFICATION_GRACE_DAYS = 2;
  const nowMs = Date.now();
  for (const event of cfgLog.events ?? []) {
    if (!RECLASSIFICATION_TYPES.has(event.type)) continue;
    if (RESOLVED_BACKFILL_STATUSES.has(event.backfillStatus)) continue;
    const ageDays = (nowMs - Date.parse(event.date)) / 86_400_000;
    const message =
      `changelog event "${event.id}" (${event.type}, ${event.date}) has backfillStatus ` +
      `"${event.backfillStatus ?? "(none)"}" — a reclassification must backfill every historical ` +
      `artifact it affects, or record backfillStatus:"not-possible" with a note explaining why not. ` +
      `See scripts/backfill-escrow-vault-reclassification.js for the pattern (a flat, validated delta ` +
      `is usually exact and cheap when the reclassified addresses are static).`;
    if (!Number.isFinite(ageDays) || ageDays > RECLASSIFICATION_GRACE_DAYS) {
      failures.push(message);
    } else {
      warnings.push(`${message} (${ageDays.toFixed(1)} days old — within the ${RECLASSIFICATION_GRACE_DAYS}-day grace period, not yet failing)`);
    }
  }

  // --- 8. Holder count day-over-day. A WARN, never a failure: real events
  // (listings, airdrops, reclassifications) move it. Known dates are allowed via
  // changelog event dates, declared series breaks (breaksSeries, `at` when set) and the\n  // config health.consistency.knownHolderChangeDates override;
  // anything else is surfaced so a silent classification break is not missed.
  const opts = resolveConsistencyOptions(project.config, [...(cfgLog.events ?? []).map((e) => e.date), ...seriesBreakDates(cfgLog.events)]);
  for (const c of holderDayChanges(history?.entries, opts)) {
    warnings.push(
      `holder count moved ${c.pct.toFixed(1)}% on ${c.date} (${fmt(c.previous)} -> ${fmt(c.current)}), ` +
        `over the ${opts.maxPct}% day-over-day threshold; if expected, add the date to ` +
        `health.consistency.knownHolderChangeDates in config/projects/${project.slug}.json`,
    );
  }

  // --- 9. Placeholder feeds (intentional stubs) must be rewritten with the
  // snapshot, not left over from an earlier run.
  const snapshotMs = Date.parse(lite?.generatedAt ?? "");
  const placeholders = [];
  for (const feed of resolveFeedHealth(project.config).filter((f) => f.placeholder)) {
    placeholders.push({ file: feed.file, doc: await read(feed.file, { optional: true }) });
  }
  if (Number.isFinite(snapshotMs)) {
    for (const p of placeholderLag(placeholders, snapshotMs, opts.placeholderSlackMs)) {
      warnings.push(`placeholder ${p.file} (generated ${p.generatedAt}) is older than the holders snapshot (${lite.generatedAt})`);
    }
  }

  // --- 7. Staleness. Feeds are produced by three different workflows on three
  // crons, so they are never byte-simultaneous; this only flags real drift.
  const now = Date.now();
  for (const [name, doc] of [
    ["holders-lite.json", lite],
    ["supply-reconciliation.json", supply],
    ["exchange-flow-history.json", await read("exchange-flow-history.json", { optional: true })],
    ["tier-outflows.json", await read("tier-outflows.json", { optional: true })],
  ]) {
    // Intentional stubs are checked by (9), not aged here.
    if (placeholders.some((p) => p.file === name)) continue;
    const ts = Date.parse(doc?.generatedAt ?? "");
    if (!Number.isFinite(ts)) continue;
    const days = (now - ts) / 86_400_000;
    if (days > STALE_DAYS) warnings.push(`${name} is ${days.toFixed(1)} days old`);
  }

  for (const c of checks) console.log(`  ok   ${c}`);
  for (const w of warnings) console.log(`  WARN ${w}`);
  for (const f of failures) console.error(`  FAIL ${f}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} consistency failure(s) — refusing to pass.`);
    process.exit(1);
  }
  if (strict && warnings.length > 0) {
    console.error(`\n--strict: ${warnings.length} warning(s) treated as failures.`);
    process.exit(1);
  }
  console.log(`\nAll ${checks.length} cross-feed checks passed${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`);
};

await main();
