/**
 * Registry-driven feed health and cross-feed sanity helpers, shared by
 * scripts/pipeline-health.js and scripts/check-feed-consistency.js.
 *
 * Nothing here names a project. DEFAULT_FEEDS is the baseline every registered
 * project is held to; a project overrides it from its own config:
 *
 *   "health": {
 *     "feeds": {
 *       "holders-lite.json":    { "maxAgeHours": 36 },          // tighten/loosen
 *       "tier-outflows.json":   { "placeholder": true },        // intentional stub: never stale
 *       "funding-wallets.json": { "disabled": true },           // feed does not exist here
 *       "solana-staking.json":  { "maxAgeHours": 30, "label": "Staking", "workflow": "..." }
 *     },
 *     "consistency": { "maxHolderChangePct": 2, "knownHolderChangeDates": ["YYYY-MM-DD"],
 *                       "knownGapDates": ["YYYY-MM-DD"] }   // history days that cannot be filled
 *   }
 *
 * See docs/MULTI-TOKEN.md "Feed health".
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRegistry, projectPaths, resolveProject } from "./projects.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Threshold for a feed a project adds that the default table does not know. */
const FALLBACK_MAX_AGE_HOURS = 48;
const DEFAULT_HOLDER_CHANGE_PCT = 2;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_PLACEHOLDER_SLACK_HOURS = 1;

/**
 * Baseline feeds. `thresholdMs` is deliberately wider than the cron period so a
 * single missed run does not page (see pipeline-health.js header). `fallback`
 * is the exact local recovery sequence, credential requirements first.
 */
export const DEFAULT_FEEDS = [
  {
    file: "holders-lite.json",
    label: "Holder snapshot (retail/CEX/staking)",
    thresholdMs: 36 * HOUR,
    workflow: "Refresh holders snapshots",
    fallback: [
      "Needs ENV_PASSPHRASE + ETHERSCAN_API_KEY (full chain rescan).",
      "export ENV_PASSPHRASE=... ETHERSCAN_API_KEY=...",
      "node scripts/pull-staker-balances.js",
      "node scripts/pull-holders-rpc.js",
      "node scripts/pull-cex-wallets.js",
      "node scripts/generate-holders-lite.js",
      "node scripts/generate-holders-history.js",
      "node scripts/generate-holder-transitions.js",
      "node scripts/reconcile-supply.js",
      "node scripts/append-treasury-history.js",
      "node scripts/sync-classification-changelog.js",
      "npm run check:feeds",
    ],
  },
  {
    file: "exchange-flow-history.json",
    label: "Exchange deposit/withdrawal flows",
    thresholdMs: 48 * HOUR,
    workflow: "Scan exchange flows",
    fallback: [
      "Needs ENV_PASSPHRASE only (uncapped alchemy_getAssetTransfers path, not the",
      "10-block-capped eth_getLogs scanner — see extend-transfer-caches.js header).",
      "export ENV_PASSPHRASE=...",
      "node scripts/extend-transfer-caches.js",
      "node scripts/append-exchange-flows-from-cache.js",
      "npm run check:feeds",
    ],
  },
  {
    file: "tier-outflows.json",
    label: "Tier-level outflow attribution",
    thresholdMs: 4 * DAY,
    workflow: "Generate tier outflows",
    fallback: [
      "NO local fallback exists. generate-tier-outflows.js's dexSwap/dexLp split",
      "needs an eth_getTransactionReceipt per DEX tx; the cached transfer files",
      "carry no tx hash (normalizeTransfer drops it). This can only be closed by",
      "the real workflow running — i.e. by clearing the Actions block, not by",
      "running anything in this environment. Flag this to the user directly.",
    ],
  },
  {
    file: "funding-wallets.json",
    label: "Staker balances (staking attribution)",
    // Wider than the others on purpose: pull-staker-balances.js is now
    // non-fatal in both workflows (see refresh-tel-holders.yml), so a day or
    // two of quota exhaustion costs freshness here instead of costing the
    // whole holders feed. That trade is only safe if the staleness is VISIBLE,
    // which is what this entry is for — without it, stale staking attribution
    // would be silently folded into every holder balance with nothing
    // reporting it.
    thresholdMs: 3 * DAY,
    workflow: "Refresh holders snapshots",
    fallback: [
      "Needs ETHERSCAN_API_KEY + ENV_PASSPHRASE.",
      "export ENV_PASSPHRASE=... ETHERSCAN_API_KEY=...",
      "node scripts/pull-staker-balances.js",
      "Then re-run the holders chain so the attribution lands in the snapshot:",
      "node scripts/pull-holders-rpc.js && node scripts/generate-holders-lite.js",
      "node scripts/generate-holders-history.js",
      "If this fails with 'Monthly capacity limit exceeded', it is the Alchemy",
      "account quota, not a script bug — no local fallback exists.",
    ],
  },
  {
    file: "cex-wallets.json",
    label: "CEX wallet list (Dune sync)",
    thresholdMs: 20 * DAY,
    workflow: "Sync CEX wallets from Dune",
    fallback: [
      "Needs the DUNE_API_KEY secret, which this environment does not have.",
      "No local fallback — flag to the user; this one is genuinely low urgency",
      `(${20} day threshold, biweekly cron).`,
    ],
  },
];

const isPositiveNumber = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * The feed table for one project: DEFAULT_FEEDS with its `health.feeds`
 * overrides applied, disabled feeds dropped, extra feeds appended.
 */
export function resolveFeedHealth(config) {
  const overrides = config?.health?.feeds ?? {};
  const merged = new Map(DEFAULT_FEEDS.map((f) => [f.file, { ...f, placeholder: false }]));

  for (const [file, o] of Object.entries(overrides)) {
    if (o?.maxAgeHours !== undefined && !isPositiveNumber(o.maxAgeHours)) {
      throw new Error(`health.feeds["${file}"].maxAgeHours must be a positive number (got ${JSON.stringify(o.maxAgeHours)})`);
    }
    const base = merged.get(file) ?? {
      file,
      label: file,
      thresholdMs: FALLBACK_MAX_AGE_HOURS * HOUR,
      workflow: "(see .github/workflows)",
      fallback: ["No local fallback declared; run the owning workflow."],
      placeholder: false,
    };
    merged.set(file, {
      ...base,
      ...(o.label ? { label: o.label } : {}),
      ...(o.workflow ? { workflow: o.workflow } : {}),
      ...(Array.isArray(o.fallback) ? { fallback: o.fallback } : {}),
      ...(o.maxAgeHours !== undefined ? { thresholdMs: o.maxAgeHours * HOUR } : {}),
      placeholder: o.placeholder === true,
      disabled: o.disabled === true,
    });
  }
  return [...merged.values()].filter((f) => !f.disabled).map(({ disabled: _d, ...f }) => f);
}

/** One feed's status: placeholder | missing | no-timestamp | stale | healthy. */
export function evaluateFeed(feed, doc, now) {
  if (feed.placeholder) return { ...feed, status: "placeholder", ageMs: null };
  if (!doc) return { ...feed, status: "missing", ageMs: null };
  const generatedAt = Date.parse(doc.generatedAt ?? "");
  if (!Number.isFinite(generatedAt)) return { ...feed, status: "no-timestamp", ageMs: null };
  const ageMs = now - generatedAt;
  return { ...feed, status: ageMs > feed.thresholdMs ? "stale" : "healthy", ageMs };
}

export const isUnhealthy = (result) => result.status !== "healthy" && result.status !== "placeholder";

/**
 * Freshness is not completeness: a day the pipeline never ran for leaves a hole
 * no staleness check can see. Anchored on `today`, not the latest row, so a
 * TRAILING gap (pipeline stopped entirely) is visible. Days before the
 * project's first history row are not gaps — it did not exist yet.
 * `knownGapDates` are days declared unfillable: reported in `known`, not `missing`.
 */
export function findHistoryGaps(entries, { today = new Date(), windowDays = 30, knownGapDates = [] } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const present = new Set(entries.map((e) => e.date));
  const first = entries[0].date;
  const latest = entries[entries.length - 1].date;
  const known = new Set(knownGapDates);
  const missing = [];
  const knownMissing = [];
  for (let back = 1; back <= windowDays; back++) {
    const day = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - back);
    const date = day.toISOString().slice(0, 10);
    if (date < first || present.has(date)) continue;
    (known.has(date) ? knownMissing : missing).push(date);
  }
  const windowStart = new Date(`${latest}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
  const start = windowStart.toISOString().slice(0, 10);
  const withoutCumulative = entries.filter((e) => e.date >= start && typeof e.cumulativeHolders !== "number");
  return { latest, windowDays, missing: missing.sort(), known: knownMissing.sort(), withoutCumulative: withoutCumulative.map((e) => e.date) };
}

/**
 * Days whose combined holder count moved more than `maxPct` versus the
 * previous row, within `lookbackDays` of the latest row, minus `allowDates`
 * (known classification breaks).
 */
export function holderDayChanges(entries, { maxPct = DEFAULT_HOLDER_CHANGE_PCT, lookbackDays = DEFAULT_LOOKBACK_DAYS, allowDates = [] } = {}) {
  if (!Array.isArray(entries) || entries.length < 2) return [];
  const allowed = new Set(allowDates);
  const cutoff = new Date(`${entries[entries.length - 1].date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
  const start = cutoff.toISOString().slice(0, 10);
  const out = [];
  for (let i = 1; i < entries.length; i++) {
    const { date } = entries[i];
    if (date < start || allowed.has(date)) continue;
    const previous = entries[i - 1].combined?.holderCount;
    const current = entries[i].combined?.holderCount;
    if (!(previous > 0) || !Number.isFinite(current)) continue;
    const pct = ((current - previous) / previous) * 100;
    if (Math.abs(pct) > maxPct) out.push({ date, previous, current, pct });
  }
  return out;
}

/**
 * Dates of declared series breaks (changelog events with `breaksSeries`):
 * `breaksSeries.at` when present, else the event date. The day-over-day holder
 * check skips these so no per-project date list is needed.
 */
export function seriesBreakDates(events) {
  return (events ?? []).filter((e) => e?.breaksSeries).map((e) => e.breaksSeries.at ?? e.date).filter(Boolean);
}

/** Consistency options from `health.consistency`; `extraAllowDates` are merged in (e.g. changelog event dates). */
export function resolveConsistencyOptions(config, extraAllowDates = []) {
  const c = config?.health?.consistency ?? {};
  if (c.maxHolderChangePct !== undefined && !isPositiveNumber(c.maxHolderChangePct)) {
    throw new Error(`health.consistency.maxHolderChangePct must be a positive number (got ${JSON.stringify(c.maxHolderChangePct)})`);
  }
  return {
    maxPct: c.maxHolderChangePct ?? DEFAULT_HOLDER_CHANGE_PCT,
    lookbackDays: c.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
    allowDates: [...new Set([...(c.knownHolderChangeDates ?? []), ...extraAllowDates])],
    placeholderSlackMs: (c.placeholderSlackHours ?? DEFAULT_PLACEHOLDER_SLACK_HOURS) * HOUR,
  };
}

/** Placeholder feeds generated earlier than the snapshot (minus slack): they were not rewritten this run. */
export function placeholderLag(placeholders, snapshotMs, slackMs) {
  const out = [];
  for (const { file, doc } of placeholders) {
    const ts = Date.parse(doc?.generatedAt ?? "");
    if (Number.isFinite(ts) && ts < snapshotMs - slackMs) out.push({ file, generatedAt: doc.generatedAt });
  }
  return out;
}

const readJsonSync = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** Health of one resolved project: `{ slug, results, gaps, healthy }`. */
export function evaluateProjectHealth(project, { root = process.cwd(), now = Date.now() } = {}) {
  const data = projectPaths(project, root);
  const results = resolveFeedHealth(project.config).map((feed) =>
    evaluateFeed(feed, feed.placeholder ? null : readJsonSync(data(feed.file)), now),
  );
  const gaps = findHistoryGaps(readJsonSync(data("holders-history.json"))?.entries, {
    today: new Date(now),
    knownGapDates: project.config?.health?.consistency?.knownGapDates ?? [],
  });
  return { slug: project.slug, results, gaps, healthy: !results.some(isUnhealthy) };
}

/**
 * Every registered project (or just `slugs`). A project whose config cannot be
 * loaded is reported unhealthy with `error`, so one broken config cannot hide
 * the others. An unknown slug throws.
 */
export function evaluateAllProjects({ root = process.cwd(), now = Date.now(), slugs } = {}) {
  const registry = loadRegistry(root).map((p) => p.slug);
  for (const slug of slugs ?? []) {
    if (!registry.includes(slug)) throw new Error(`unknown project "${slug}" (config/projects.json has: ${registry.join(", ")})`);
  }
  const projects = (slugs ?? registry).map((slug) => {
    try {
      return evaluateProjectHealth(resolveProject(slug, root), { root, now });
    } catch (error) {
      return { slug, results: [], gaps: null, healthy: false, error: `${slug}: ${error.message}` };
    }
  });
  return { projects, healthy: projects.every((p) => p.healthy) };
}

/**
 * Recovery commands for a non-default project: the same scripts, pinned with
 * `--project <slug>` (the default project needs no flag).
 */
export function fallbackFor(feed, project) {
  if (project.isDefault) return feed.fallback;
  return feed.fallback.map((line) => line.replace(/(node scripts\/[\w.-]+\.js)/g, `$1 --project ${project.slug}`));
}

/**
 * `--all` for per-project scripts: re-run `scriptUrl` (import.meta.url) once per
 * registered project in its own process, so each keeps its per-project
 * constants. Returns the number of failed projects.
 */
export function runForEachProject(scriptUrl, passthrough = [], root = process.cwd()) {
  let failed = 0;
  for (const { slug } of loadRegistry(root)) {
    console.log(`
== ${slug} ==`);
    const run = spawnSync(process.execPath, [fileURLToPath(scriptUrl), ...passthrough, "--project", slug], { stdio: "inherit", cwd: root });
    if (run.status !== 0) failed++;
  }
  return failed;
}
