/**
 * Alchemy as a BACKUP for Solana flow scans only (scripts/scan-solana-flows.js ->
 * flowScan.scanVenueFlows({ backupCall })). Helius and the public endpoint stay first, exactly
 * as before; this is tried only after the existing endpoints failed or throttled for that call.
 *
 * Keys: SOLANA_FLOW_RPC_0..9 (.env.enc), deliberately NOT SOLANA_RPC_*, so rpc.js
 * `notAlchemy` keeps dropping Alchemy from every other Solana pool and solanaCall refuses it.
 * Nothing but scan-solana-flows.js reads these variables.
 *
 * Cost control: a monthly cap (config/budgets.json monthly.solanaBackupAlchemyCu, UTC month,
 * month-to-date from the usage files plus this run) and the shared pool ceiling
 * (monthly.alchemyCu). At either limit the backup switches off for the rest of the run with a
 * warning; the scan carries on with the existing endpoints and anything that failed waits in
 * the checkpoint (an error aborts the chunk before its cursor moves).
 *
 * This path bypasses rpc.js guardAlchemyCall on purpose: the nightly job budget there protects
 * EVM jobs and is 0 for a Solana-only project. Backup calls are metered under their own
 * provider key (SOLANA_BACKUP_PROVIDER) so they count in alchemyCu and the shared pool without
 * ever consuming or tripping an EVM/staking job budget.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ALCHEMY_CU, ALCHEMY_DEFAULT_CU, classifyProvider, earlierProcessesSum, monthlyAlchemy, monthlySolanaBackupCu, processSolanaBackupCu, recordCall, estimateUsage, snapshotCalls } from "../rpcMetrics.js";

export const FLOW_BACKUP_ENV_PREFIX = "SOLANA_FLOW_RPC";
const KEY_SLOTS = 10;
/** Used when config/budgets.json has no monthly.solanaBackupAlchemyCu. */
export const DEFAULT_FLOW_BACKUP_MONTHLY_CU = 10_000_000;
/**
 * The only method a flow scan sends to the backup. Listing calls stay off it: a short or empty
 * backup page would end listSignatures early and let a cursor jump over a gap.
 */
export const FLOW_BACKUP_METHODS = Object.freeze(new Set(["getTransaction"]));

const ATTEMPTS_PER_URL = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
// A JSON-RPC error inside an HTTP 200 that means "slow down": code 429 or explicit rate wording
// (Alchemy: "exceeded its compute units per second capacity"). Not -32005 (a result-size limit)
// and not generic "exceeded ... limit" text, which also appears in invalid-parameter errors.
const THROTTLE_BODY = /rate.?limit|too many requests|throttl|compute units per second/i;
const isThrottleBody = (error) => Number(error?.code) === 429 || THROTTLE_BODY.test(String(error?.message ?? ""));

/**
 * Removes anything that could carry a key from text headed for an error or a log: every configured
 * backup URL and its key segment, http(s)/ws(s) URLs, bare Alchemy hosts, and /v2/<key> paths.
 */
export function redactBackupText(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out
    .replace(/\b(?:https?|wss?):\/\/\S+/gi, "[url]")
    .replace(/\b[\w.-]*alchemy(?:api)?\.(?:com|io)\b\S*/gi, "[url]")
    .replace(/\/v2\/[\w-]+/gi, "/v2/[key]");
}

/** The URL plus its trailing path segment (the key), for redaction of literal echoes. */
const secretsOf = (urls) => urls.flatMap((url) => [url, url.split("/").filter(Boolean).at(-1)]).filter((s) => s && s.length >= 8);

export class FlowBackupCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlowBackupCapError";
    this.code = "FLOW_BACKUP_CAP";
  }
}

/** Alchemy URLs in SOLANA_FLOW_RPC_0..9, in slot order. Anything not on an Alchemy host is ignored. */
export function flowBackupUrls(env = process.env) {
  const urls = [];
  for (let i = 0; i < KEY_SLOTS; i += 1) {
    const raw = env[`${FLOW_BACKUP_ENV_PREFIX}_${i}`];
    const url = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
    if (url && classifyProvider(url) === "alchemy") urls.push(url);
  }
  return urls;
}

/** Monthly CU cap for this backup: config/budgets.json, else the default constant. */
export function flowBackupMonthlyCap(root = process.cwd()) {
  try {
    const cap = Number(JSON.parse(fs.readFileSync(path.resolve(root, "config/budgets.json"), "utf8"))?.monthly?.solanaBackupAlchemyCu);
    if (Number.isFinite(cap) && cap >= 0) return cap;
  } catch {
    /* no budgets file: default */
  }
  return DEFAULT_FLOW_BACKUP_MONTHLY_CU;
}

const costOf = (method) => ALCHEMY_CU[method] ?? ALCHEMY_DEFAULT_CU;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {((method: string, params: unknown[]) => Promise<unknown>) | null} null when no
 *   SOLANA_FLOW_RPC_* is set (the scan then behaves exactly as without a backup).
 */
export function createFlowBackupCall({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  sleep = defaultSleep,
  root = process.cwd(),
  capCu = flowBackupMonthlyCap(root),
  usedBeforeRun = () => monthlySolanaBackupCu(root, new Date(), env),
  // Alchemy CU used this month before this process (usage files + earlier processes of this run) and the ceiling.
  pool = () => {
    const { used, ceiling } = monthlyAlchemy(root);
    return { used: used + earlierProcessesSum(env, "alchemyCu"), ceiling };
  },
} = {}) {
  const urls = flowBackupUrls(env);
  if (urls.length === 0) return null;
  const secrets = secretsOf(urls);
  const redact = (text) => redactBackupText(text, secrets);
  const reportedFailures = new Set();
  let baseUsed = null;
  let basePool = null;
  let off = false;

  const stop = (reason) => {
    if (!off) {
      off = true;
      logger.warn?.(`::warning::Solana flow backup (Alchemy) off for the rest of this run: ${reason}. The scan continues on Helius/public; failed calls wait for the next run.`);
    }
    throw new FlowBackupCapError(reason);
  };

  // Called before every billed request (retries included); records nothing itself.
  const reserve = (method) => {
    if (off) throw new FlowBackupCapError("backup already off");
    baseUsed ??= usedBeforeRun();
    const cost = costOf(method);
    const used = baseUsed + processSolanaBackupCu();
    if (used + cost > capCu) {
      stop(`monthly cap ${capCu.toLocaleString("en-US")} CU for the Solana flow backup reached (${used.toLocaleString("en-US")} CU used this month)`);
    }
    basePool ??= pool();
    const { used: poolUsed, ceiling } = basePool;
    const poolSpent = poolUsed + estimateUsage(snapshotCalls()).alchemyCu;
    if (poolSpent + cost > ceiling) {
      stop(`shared Alchemy pool ceiling ${ceiling.toLocaleString("en-US")} CU reached (${poolSpent.toLocaleString("en-US")} CU used this month; Solana backup cap ${capCu.toLocaleString("en-US")} CU)`);
    }
  };

  const tryUrl = async (url, slot, method, params) => {
    const label = `${FLOW_BACKUP_ENV_PREFIX}_${slot}`;
    let lastError = null;
    for (let attempt = 0; attempt < ATTEMPTS_PER_URL; attempt += 1) {
      reserve(method);
      recordCall(url, method, { solanaBackup: true });
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Messages never carry the URL (it holds the key).
        lastError = new Error(`${label}: ${err?.name === "TimeoutError" ? "timeout" : "network error"}`);
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        lastError = new Error(`${label}: HTTP ${res.status}`);
        if (!RETRYABLE_STATUS.has(res.status)) throw lastError;
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      const body = await res.json().catch(() => null);
      if (body?.error && isThrottleBody(body.error)) {
        lastError = new Error(`${label}: throttled`);
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      // Provider text can echo the request URL (it holds the key), so URLs are redacted.
      if (!body || body.error) throw new Error(`${label}: ${body ? redact(body.error.message ?? "RPC error").slice(0, 120) : "invalid response"}`);
      return body.result;
    }
    throw lastError;
  };

  return async function flowBackupCall(method, params) {
    if (!FLOW_BACKUP_METHODS.has(method)) throw new Error(`Solana flow backup: ${method} is not allowed`);
    const errors = [];
    for (const [slot, url] of urls.entries()) {
      try {
        return await tryUrl(url, slot, method, params);
      } catch (err) {
        if (err instanceof FlowBackupCapError) throw err;
        errors.push(err.message);
      }
    }
    // An outage (auth, HTTP, network) is not a genuine null: say so once per distinct reason per run.
    const reason = redact(errors.join(" | "));
    if (!reportedFailures.has(reason)) {
      reportedFailures.add(reason);
      logger.warn?.(`::warning::Solana flow backup (Alchemy) failed: ${reason}. Treated as no answer; check the SOLANA_FLOW_RPC_n key and plan.`);
    }
    throw new Error(reason);
  };
}
