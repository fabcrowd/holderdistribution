/**
 * Three-way merge of a per-project RPC usage file (<work>/rpc-usage.json,
 * written by scripts/summarize-run-metrics.js through mergeUsage()).
 *
 * Every value in the file is a counter that a job only ever adds to, so two
 * jobs that each added their own run to the same base merge exactly as
 *
 *     merged = ours + theirs - base        (per day, per counter, per script)
 *
 * which keeps every call and every Alchemy CU / Helius credit of both runs, so
 * the month-to-date totals the budget guard reads stay complete. git's line
 * merge cannot do this: two runs on the same day both rewrite the same lines
 * of that day's block (a conflict), or make the same edit ("runs": 1 -> 2),
 * which git keeps once and so silently drops a run.
 *
 * Used by scripts/merge-rpc-usage.js, the git merge driver that
 * scripts/push-main.sh enables for its rebase, and again after the rebase
 * from the pre-rebase trees (--from-git) because git skips the driver when
 * both sides made the identical edit. It throws instead of guessing on anything
 * that is not this shape, so the rebase stays a conflict for a human.
 */
import { KEEP_DAYS, USAGE_SCHEMA_VERSION } from "./runMetricsSummary.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function checkShape(doc, label) {
  if (doc == null) return { schemaVersion: USAGE_SCHEMA_VERSION, days: {} };
  if (!isPlainObject(doc) || !isPlainObject(doc.days ?? {})) throw new Error(`${label}: not an rpc-usage file (no "days" object)`);
  for (const d of Object.keys(doc.days ?? {})) {
    if (!DAY.test(d)) throw new Error(`${label}: unexpected day key ${JSON.stringify(d)}`);
  }
  return doc;
}

/**
 * Merges one counter tree. A side that lacks a key left it unchanged (it was
 * absent from base too, or that side pruned it), so its delta is 0.
 */
function mergeCounters(base, ours, theirs, where) {
  const out = {};
  const keys = [...new Set([...Object.keys(ours ?? {}), ...Object.keys(theirs ?? {})])];
  for (const k of keys) {
    const o = base?.[k];
    const a = ours && k in ours ? ours[k] : o;
    const b = theirs && k in theirs ? theirs[k] : o;
    const at = `${where}.${k}`;
    if ([o, a, b].some(isPlainObject)) {
      if (![o, a, b].every((v) => v === undefined || isPlainObject(v))) throw new Error(`${at}: mixed object and value`);
      out[k] = mergeCounters(o, a, b, at);
      continue;
    }
    for (const v of [o, a, b]) {
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`${at}: not a number (${JSON.stringify(v)})`);
    }
    const value = (a ?? 0) + (b ?? 0) - (o ?? 0);
    if (value < 0) throw new Error(`${at}: merge would go negative (${a ?? 0} + ${b ?? 0} - ${o ?? 0})`);
    out[k] = value;
  }
  return out;
}

/**
 * @param {object|null} base common ancestor (null when the file is new on both sides)
 * @param {object|null} ours one side (e.g. origin/main during a rebase)
 * @param {object|null} theirs the other side (e.g. the commit being replayed)
 * @param {{keepDays?: number}} [opts]
 * @returns {{schemaVersion: number, days: Record<string, object>}}
 */
export function mergeRpcUsage3(base, ours, theirs, { keepDays = KEEP_DAYS } = {}) {
  const o = checkShape(base, "base");
  const a = checkShape(ours, "ours");
  const b = checkShape(theirs, "theirs");
  const versions = [o, a, b].map((d) => d.schemaVersion ?? USAGE_SCHEMA_VERSION);
  if (new Set(versions).size > 1 || versions[0] !== USAGE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion differs or is unknown (${versions.join(", ")}); merge by hand`);
  }

  const dates = [...new Set([...Object.keys(a.days ?? {}), ...Object.keys(b.days ?? {})])].sort();
  const days = {};
  for (const d of dates) {
    const od = o.days?.[d];
    const ad = a.days && d in a.days ? a.days[d] : od;
    const bd = b.days && d in b.days ? b.days[d] : od;
    // A day one side already pruned (older than the retention window) is pruned below.
    days[d] = mergeCounters(od, ad, bd, d);
  }
  const newest = dates.at(-1);
  if (newest) {
    const cutoff = new Date(Date.parse(`${newest}T00:00:00Z`) - keepDays * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
  }
  return { schemaVersion: USAGE_SCHEMA_VERSION, days };
}
