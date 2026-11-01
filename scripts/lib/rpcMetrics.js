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
