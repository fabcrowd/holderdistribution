/**
 * Per-process RPC usage counters. rpc.js calls recordCall() for every request it
 * sends (retries and health probes included, because the provider bills each
 * one). Only the provider class and method name are kept; URLs and keys are
 * never stored.
 *
 * When HD_METRICS_FILE is set (the nightly workflow sets it), the process
 * appends one JSON line per flush: every HD_METRICS_FLUSH_MS (default 60s) and
 * on exit. Each line carries only the calls since the previous flush, so a
 * killed step keeps its usage up to the last flush. scripts/summarize-run-metrics.js
 * turns those lines into the daily usage file and checks the monthly budgets.
 *
 * CU / credit figures are ESTIMATES from the providers' published rate cards;
 * the Alchemy and Helius dashboards stay the source of truth for billing.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** Alchemy compute-unit cost per method (published rate card). Unlisted methods use the default. */
export const ALCHEMY_CU = Object.freeze({
  eth_blockNumber: 10,
  eth_chainId: 0,
  eth_call: 26,
  eth_getLogs: 75,
  eth_getBalance: 19,
  eth_getCode: 19,
  eth_getBlockByNumber: 16,
  eth_getBlockReceipts: 20,
  eth_getTransactionByHash: 17,
  eth_getTransactionReceipt: 20,
  eth_getStorageAt: 17,
  alchemy_getTokenBalances: 20,
  alchemy_getAssetTransfers: 120,
});
export const ALCHEMY_DEFAULT_CU = 26;

/** Helius credits per method: 1 per standard RPC call; heavy scans cost more (estimate, verify in the dashboard). */
export const HELIUS_CREDITS = Object.freeze({ getProgramAccounts: 10, getTokenAccounts: 10 });
export const HELIUS_DEFAULT_CREDITS = 1;

/** @param {string} url @returns {"alchemy"|"helius"|"public"} (public = any other endpoint, keyed or not) */
export function classifyProvider(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "public";
  }
  const isHostOrSubdomain = (value, domain) => value === domain || value.endsWith(`.${domain}`);
  if (isHostOrSubdomain(host, "alchemy.com") || isHostOrSubdomain(host, "alchemyapi.io")) return "alchemy";
  if (isHostOrSubdomain(host, "helius-rpc.com") || isHostOrSubdomain(host, "helius.dev")) return "helius";
  return "public";
}

/** @type {Map<string, number>} */
const counts = new Map();
/** Counts as of the last successful flush; each flush writes only the difference. @type {Map<string, number>} */
const flushed = new Map();
let hooked = false;
/** @type {NodeJS.Timeout | null} */
let flushTimer = null;
const startedMs = Date.now();

export function recordCall(url, method) {
  const key = `${classifyProvider(url)}|${method}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  installExitHook();
}

/** @param {Map<string, number>} map keyed "provider|method" @returns {Record<string, Record<string, number>>} */
function toNested(map) {
  const out = {};
  for (const [key, n] of map) {
    if (n <= 0) continue;
    const [provider, method] = key.split("|");
    (out[provider] ??= {})[method] = n;
  }
  return out;
}

/** @returns {Record<string, Record<string, number>>} provider -> method -> calls */
export function snapshotCalls() {
  return toNested(counts);
}

/** @param {Record<string, Record<string, number>>} calls */
export function estimateUsage(calls) {
  let alchemyCu = 0;
  for (const [method, n] of Object.entries(calls.alchemy ?? {})) alchemyCu += n * (ALCHEMY_CU[method] ?? ALCHEMY_DEFAULT_CU);
  let heliusCredits = 0;
  for (const [method, n] of Object.entries(calls.helius ?? {})) heliusCredits += n * (HELIUS_CREDITS[method] ?? HELIUS_DEFAULT_CREDITS);
  const total = (p) => Object.values(calls[p] ?? {}).reduce((a, b) => a + b, 0);
  return { alchemyCu, heliusCredits, alchemyCalls: total("alchemy"), heliusCalls: total("helius"), publicCalls: total("public") };
}

/** Calls recorded since the last successful flush, keyed "provider|method". */
function unflushedCounts() {
  const delta = new Map();
  for (const [key, n] of counts) {
    const d = n - (flushed.get(key) ?? 0);
    if (d > 0) delta.set(key, d);
  }
  return delta;
}

function flush() {
  const file = process.env.HD_METRICS_FILE;
  if (!file) return;
  try {
    const delta = unflushedCounts();
    if (delta.size === 0) return;
    const calls = toNested(delta);
    const line = {
      script: path.basename(process.argv[1] ?? "unknown"),
      project: process.env.HD_PROJECT_SLUG || process.env.HD_PROJECT || null,
      pid: process.pid,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      calls,
      ...estimateUsage(calls),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    for (const [key, n] of counts) flushed.set(key, n);
  } catch (err) {
    // Metrics must never break a data run. A failed write leaves the delta
    // unflushed, so the next flush retries it.
    console.error(`[rpcMetrics] could not write ${path.basename(file)}: ${err?.message ?? err}`);
  }
}

function installExitHook() {
  if (hooked || !process.env.HD_METRICS_FILE) return;
  hooked = true;
  process.once("exit", flush);
  // Periodic flush so a process killed before exit (CI timeout, cancel) keeps its usage.
  flushTimer = setInterval(flush, Number(process.env.HD_METRICS_FLUSH_MS) || 60000);
  flushTimer.unref();
}

/** Test hook. */
export function __resetRpcMetricsForTests() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  process.off("exit", flush);
  counts.clear();
  flushed.clear();
  hooked = false;
}

/** Test hook: write the current counters now. */
export const __flushRpcMetricsForTests = flush;

// ---------------------------------------------------------------------------
// Alchemy budget guard (config/nightly-jobs.json via workflow-paths.js `job`).
//
// Active only when HD_JOB_ID is set (nightly workflow steps), so local runs and
// tests behave exactly as before. Two limits:
//   per run   HD_JOB_ALCHEMY_CU_BUDGET — this process's estimated Alchemy CU
//   monthly   config/budgets.json monthly.alchemyCu vs data/rpc-usage.json
//             (this UTC month, every project) + this process
// HD_JOB_BUDGET_MODE=enforce refuses the call (AlchemyBudgetError, so rpc.js
// fails over to the next provider or the alchemyOnly job skips); "warn" only
// logs one ::warning:: per process and lets the call through.
// ---------------------------------------------------------------------------

export class AlchemyBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlchemyBudgetError";
    this.code = "ALCHEMY_BUDGET";
  }
}

export const isAlchemyBudgetError = (err) => err?.code === "ALCHEMY_BUDGET";

/** Estimated Alchemy CU this process has sent so far. */
export function processAlchemyCu() {
  return estimateUsage(snapshotCalls()).alchemyCu;
}

let monthCache = null;
/** Alchemy CU already recorded this UTC month (data/rpc-usage.json) and the monthly ceiling. */
export function monthlyAlchemy(root = process.cwd(), now = new Date()) {
  if (monthCache) return monthCache;
  const month = now.toISOString().slice(0, 7);
  let used = 0;
  let ceiling = Infinity;
  // Every project's usage file: data/rpc-usage.json (TEL) + data/<slug>/rpc-usage.json.
  const files = [path.resolve(root, "data/rpc-usage.json")];
  try {
    for (const d of fs.readdirSync(path.resolve(root, "data"), { withFileTypes: true })) {
      if (d.isDirectory()) files.push(path.resolve(root, "data", d.name, "rpc-usage.json"));
    }
  } catch {
    /* no data dir */
  }
  for (const f of files) {
    try {
      const usage = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const [day, d] of Object.entries(usage.days ?? {})) if (day.startsWith(month)) used += Number(d.alchemyCu) || 0;
    } catch {
      /* no usage yet */
    }
  }
  try {
    const b = JSON.parse(fs.readFileSync(path.resolve(root, "config/budgets.json"), "utf8"));
    const c = Number(b?.monthly?.alchemyCu);
    if (Number.isFinite(c) && c > 0) ceiling = c;
  } catch {
    /* no ceiling configured */
  }
  monthCache = { month, used, ceiling };
  return monthCache;
}

let jobCache = null;
/**
 * HD_JOB_* with defaults filled from config/nightly-jobs.json, so a workflow step
 * only has to set HD_JOB_ID. Explicit HD_JOB_* env always wins.
 */
export function resolveJobEnv(env = process.env, root = process.cwd()) {
  if (!env.HD_JOB_ID) return env;
  if (!jobCache || jobCache.id !== env.HD_JOB_ID) {
    let job = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.resolve(root, "config/nightly-jobs.json"), "utf8"));
      job = (cfg.jobs ?? []).find((j) => j.id === env.HD_JOB_ID) ?? null;
    } catch {
      /* no config: explicit env only */
    }
    jobCache = { id: env.HD_JOB_ID, job };
  }
  const job = jobCache.job;
  const out = {
    ...env,
    HD_JOB_PROVIDERS: env.HD_JOB_PROVIDERS ?? (job ? (job.providers ?? []).join(",") : undefined),
    HD_JOB_ALCHEMY_CU_BUDGET: env.HD_JOB_ALCHEMY_CU_BUDGET ?? (job ? String(Number(job.alchemyCuPerNight) || 0) : undefined),
    HD_JOB_ALCHEMY_ONLY: env.HD_JOB_ALCHEMY_ONLY ?? (job?.alchemyOnly ? "true" : "false"),
    HD_JOB_BUDGET_MODE: env.HD_JOB_BUDGET_MODE ?? (job?.budgetMode === "warn" ? "warn" : "enforce"),
  };
  // No Alchemy on Solana: a project without an EVM chain (HD_HAS_EVM=false, from
  // workflow-paths.js) gets a hard 0-CU enforced budget and no "alchemy" provider.
  if (env.HD_HAS_EVM === "false") {
    out.HD_JOB_PROVIDERS = String(out.HD_JOB_PROVIDERS ?? "").split(",").filter((p) => p && p !== "alchemy").join(",");
    out.HD_JOB_ALCHEMY_CU_BUDGET = "0";
    out.HD_JOB_BUDGET_MODE = "enforce";
  }
  return out;
}

const warned = new Set();
/**
 * Called by rpc.js before every Alchemy request. Returns normally when the call
 * may go out; throws AlchemyBudgetError when an enforced budget would be exceeded.
 */
export function guardAlchemyCall(method, rawEnv = process.env) {
  if (!rawEnv.HD_JOB_ID) return;
  const env = resolveJobEnv(rawEnv);
  const cost = ALCHEMY_CU[method] ?? ALCHEMY_DEFAULT_CU;
  const spent = processAlchemyCu();
  const runBudget = Number(env.HD_JOB_ALCHEMY_CU_BUDGET);
  const { used, ceiling } = monthlyAlchemy();
  let reason = null;
  if (Number.isFinite(runBudget) && spent + cost > runBudget) reason = `job ${env.HD_JOB_ID} Alchemy budget ${runBudget} CU/run reached (${spent} spent)`;
  else if (used + spent + cost > ceiling) reason = `monthly Alchemy ceiling ${ceiling} CU reached (${used + spent} this month)`;
  if (!reason) return;
  if (env.HD_JOB_BUDGET_MODE === "warn") {
    if (!warned.has(reason.split(" (")[0])) {
      warned.add(reason.split(" (")[0]);
      console.warn(`::warning::[budget] ${reason} — budgetMode=warn, call allowed`);
    }
    return;
  }
  throw new AlchemyBudgetError(`[budget] ${reason} — refusing ${method}`);
}

/** True when the guard would refuse any Alchemy call right now (used to drop keys from a pool up front). */
export function alchemyBlocked(rawEnv = process.env) {
  if (!rawEnv.HD_JOB_ID) return false;
  const env = resolveJobEnv(rawEnv);
  if (env.HD_JOB_BUDGET_MODE === "warn") return false;
  try {
    guardAlchemyCall("eth_blockNumber", env);
    return false;
  } catch (err) {
    if (isAlchemyBudgetError(err)) return true;
    throw err;
  }
}

/** Test hook. */
export function __resetBudgetGuardForTests() {
  monthCache = null;
  jobCache = null;
  warned.clear();
}
