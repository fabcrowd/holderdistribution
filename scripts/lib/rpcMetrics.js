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
  // Solana (published Alchemy rate card); other Solana methods fall to the default.
  getTransaction: 40,
  getSignaturesForAddress: 40,
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

/** Provider key for Alchemy calls made as the Solana flow-scan backup (see lib/solana/flowBackup.js). */
export const SOLANA_BACKUP_PROVIDER = "alchemy-solana";

/** @param {{ solanaBackup?: boolean }} [opts] solanaBackup: bill this call to the Solana flow-scan backup */
export function recordCall(url, method, { solanaBackup = false } = {}) {
  const key = `${solanaBackup ? SOLANA_BACKUP_PROVIDER : classifyProvider(url)}|${method}`;
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
  // The Solana backup is Alchemy usage too (it counts toward alchemyCu and the shared pool),
  // and is also reported on its own so its separate monthly cap can be enforced.
  let solanaBackupCu = 0;
  for (const [method, n] of Object.entries(calls[SOLANA_BACKUP_PROVIDER] ?? {})) solanaBackupCu += n * (ALCHEMY_CU[method] ?? ALCHEMY_DEFAULT_CU);
  alchemyCu += solanaBackupCu;
  let heliusCredits = 0;
  for (const [method, n] of Object.entries(calls.helius ?? {})) heliusCredits += n * (HELIUS_CREDITS[method] ?? HELIUS_DEFAULT_CREDITS);
  const total = (p) => Object.values(calls[p] ?? {}).reduce((a, b) => a + b, 0);
  // Reported only when the backup was used, so usage lines and files of other projects keep their shape.
  return { alchemyCu, ...(solanaBackupCu > 0 && { solanaBackupCu }), heliusCredits, alchemyCalls: total("alchemy") + total(SOLANA_BACKUP_PROVIDER), heliusCalls: total("helius"), publicCalls: total("public") };
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
      job: process.env.HD_JOB_ID || null,
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
//   per run   HD_JOB_ALCHEMY_CU_BUDGET — estimated Alchemy CU of this process plus
//             earlier processes of the same job in this run (HD_METRICS_FILE)
//   monthly   config/budgets.json monthly.alchemyCu vs data/rpc-usage.json
//             (this UTC month, every project) + this process
// HD_JOB_BUDGET_MODE=enforce refuses the call (AlchemyBudgetError, so rpc.js
// fails over to the next provider or the alchemyOnly job skips); "warn" logs one
// ::warning:: per process for a per-run overrun. The monthly ceiling is always enforced.
// ---------------------------------------------------------------------------

export class AlchemyBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlchemyBudgetError";
    this.code = "ALCHEMY_BUDGET";
  }
}

export const isAlchemyBudgetError = (err) => err?.code === "ALCHEMY_BUDGET";

/** Estimated Alchemy CU this process has sent so far, excluding the Solana backup (it has its own cap and no job budget). */
export function processAlchemyCu() {
  const { alchemyCu, solanaBackupCu = 0 } = estimateUsage(snapshotCalls());
  return alchemyCu - solanaBackupCu;
}

/** Every project's usage file: data/rpc-usage.json (TEL) + data/<slug>/rpc-usage.json. */
function usageFiles(root) {
  const files = [path.resolve(root, "data/rpc-usage.json")];
  try {
    for (const d of fs.readdirSync(path.resolve(root, "data"), { withFileTypes: true })) {
      if (d.isDirectory()) files.push(path.resolve(root, "data", d.name, "rpc-usage.json"));
    }
  } catch {
    /* no data dir */
  }
  return files;
}

/** Sum of `field` over this UTC month's days in every project's usage file. */
function monthSum(root, month, field) {
  let total = 0;
  for (const f of usageFiles(root)) {
    try {
      const usage = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const [day, d] of Object.entries(usage.days ?? {})) if (day.startsWith(month)) total += Number(d[field]) || 0;
    } catch {
      /* no usage yet */
    }
  }
  return total;
}

let monthCache = null;
/** Alchemy CU already recorded this UTC month (data/rpc-usage.json) and the monthly ceiling. */
export function monthlyAlchemy(root = process.cwd(), now = new Date()) {
  if (monthCache) return monthCache;
  const month = now.toISOString().slice(0, 7);
  const used = monthSum(root, month, "alchemyCu");
  let ceiling = Infinity;
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

/**
 * Solana-backup Alchemy CU already spent this UTC month before this process: the usage files
 * plus earlier processes of this run still sitting in HD_METRICS_FILE (not folded into the
 * usage file until summarize-run-metrics runs). May over-count if a summary already ran on the
 * same metrics file; that errs on the side of stopping the backup early.
 */
export function monthlySolanaBackupCu(root = process.cwd(), now = new Date(), env = process.env) {
  return monthSum(root, now.toISOString().slice(0, 7), "solanaBackupCu") + earlierProcessesSum(env, "solanaBackupCu");
}

/** Sum of `field` over the metrics lines of OTHER processes of this run (HD_METRICS_FILE). */
export function earlierProcessesSum(env, field) {
  if (!env.HD_METRICS_FILE) return 0;
  let raw = "";
  try {
    raw = fs.readFileSync(env.HD_METRICS_FILE, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const text of raw.split("\n").filter(Boolean)) {
    try {
      const line = JSON.parse(text);
      if (line.pid !== process.pid) total += Number(line[field]) || 0;
    } catch {
      /* truncated line from a killed process */
    }
  }
  return total;
}

/** Solana-backup Alchemy CU this process has sent so far. */
export const processSolanaBackupCu = () => estimateUsage(snapshotCalls()).solanaBackupCu ?? 0;

/** Alchemy CU that earlier processes of this job already spent in this run. */
function priorJobAlchemyCu(env) {
  if (!env.HD_METRICS_FILE) return 0;
  let raw;
  try {
    raw = fs.readFileSync(env.HD_METRICS_FILE, "utf8");
  } catch {
    return 0;
  }
  const project = env.HD_PROJECT_SLUG || env.HD_PROJECT || null;
  return raw.split("\n").filter(Boolean).reduce((total, text) => {
    const line = JSON.parse(text);
    const sameJob = line.job === env.HD_JOB_ID && line.project === project && line.pid !== process.pid;
    return sameJob ? total + (Number(line.alchemyCu) || 0) - (Number(line.solanaBackupCu) || 0) : total;
  }, 0);
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

/** True when this nightly job lists a public provider ahead of Alchemy. */
export function jobPrefersPublic(rawEnv = process.env) {
  if (!rawEnv.HD_JOB_ID) return false;
  const providers = String(resolveJobEnv(rawEnv).HD_JOB_PROVIDERS ?? "").split(",");
  const publicAt = providers.indexOf("public");
  const alchemyAt = providers.indexOf("alchemy");
  return publicAt >= 0 && (alchemyAt < 0 || publicAt < alchemyAt);
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
  const spent = processAlchemyCu() + priorJobAlchemyCu(env);
  const runBudget = Number(env.HD_JOB_ALCHEMY_CU_BUDGET);
  const { used, ceiling } = monthlyAlchemy();
  if (used + spent + cost > ceiling) {
    throw new AlchemyBudgetError(`[budget] monthly Alchemy ceiling ${ceiling} CU reached (${used + spent} this month) — refusing ${method}`);
  }
  if (!(Number.isFinite(runBudget) && spent + cost > runBudget)) return;
  const reason = `job ${env.HD_JOB_ID} Alchemy budget ${runBudget} CU/run reached (${spent} spent)`;
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
