/**
 * Client-side throttle for KEYLESS public RPC endpoints, shared by every caller in
 * the process (holders scan, wallet flows, ledger, trace scripts, Solana scans all
 * reach the network through rpc.js rpcCall()).
 *
 * Why: public nodes rate-limit per IP. The ONDO cold scan sent 2 concurrent
 * eth_getLogs plus failover retries at full speed; rpc.mevblocker.io answered with
 * Cloudflare 429s carrying `Retry-After: 0`, so the old ladder retried 5x with no
 * delay (the "Retrying in 0ms" lines) and then dumped the chunk onto Tenderly too.
 *
 * Only hosts listed in config/public-rpc-limits.json are limited, so Alchemy,
 * Helius and any keyed endpoint keep their exact current behaviour.
 *
 * Per host: a token bucket (rps/burst), a concurrency cap, and AIMD — a 429 halves
 * that host's rate (floor 10%) and every later success creeps it back up.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config/public-rpc-limits.json");

let config = null;
function loadConfig() {
  if (config) return config;
  let base = { default: {}, hosts: {} };
  try {
    base = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* no config: nothing is limited */
  }
  let override = {};
  try {
    override = process.env.RPC_LIMITS_JSON ? JSON.parse(process.env.RPC_LIMITS_JSON) : {};
  } catch {
    override = {};
  }
  config = { default: base.default ?? {}, hosts: { ...(base.hosts ?? {}), ...override } };
  return config;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The configured limits for a URL's host, or null when the host is not a limited public endpoint. */
export function limitsFor(url) {
  if (/^(off|0|false|no)$/i.test(process.env.RPC_LIMITER ?? "")) return null;
  const cfg = loadConfig();
  const host = hostOf(url);
  const own = cfg.hosts[host];
  if (!own) return null;
  return { ...cfg.default, ...own };
}

export const isLimitedPublicUrl = (url) => limitsFor(url) !== null;

const states = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateFor(url) {
  const host = hostOf(url);
  let s = states.get(host);
  if (!s) {
    const l = limitsFor(url);
    s = {
      baseRps: Number(l.rps) > 0 ? Number(l.rps) : 4,
      rps: Number(l.rps) > 0 ? Number(l.rps) : 4,
      burst: Number(l.burst) > 0 ? Number(l.burst) : 1,
      concurrency: Number(l.concurrency) > 0 ? Number(l.concurrency) : 1,
      tokens: Number(l.burst) > 0 ? Number(l.burst) : 1,
      last: Date.now(),
      inFlight: 0,
      waiters: [],
      pausedUntil: 0,
    };
    states.set(host, s);
  }
  return s;
}

/**
 * Waits for a slot on a limited host; returns a release function. For an
 * unlimited host returns a no-op immediately (no await-induced reordering).
 */
export async function acquire(url) {
  if (!isLimitedPublicUrl(url)) return () => {};
  const s = stateFor(url);
  // A released slot is handed straight to the next waiter (inFlight unchanged),
  // so a newcomer can never slip in between and exceed the cap.
  if (s.inFlight >= s.concurrency) await new Promise((r) => s.waiters.push(r));
  else s.inFlight++;
  for (;;) {
    const now = Date.now();
    if (now < s.pausedUntil) {
      await sleep(s.pausedUntil - now);
      continue;
    }
    s.tokens = Math.min(s.burst, s.tokens + ((now - s.last) / 1000) * s.rps);
    s.last = now;
    if (s.tokens >= 1) {
      s.tokens -= 1;
      break;
    }
    await sleep(Math.ceil(((1 - s.tokens) / s.rps) * 1000));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = s.waiters.shift();
    if (next) next();
    else s.inFlight--;
  };
}

/** A 429/503 from a limited host: halve its rate and pause the whole host for `pauseMs`. */
export function penalize(url, pauseMs = 0) {
  if (!isLimitedPublicUrl(url)) return;
  const s = stateFor(url);
  s.rps = Math.max(s.baseRps * 0.1, s.rps / 2);
  s.tokens = Math.min(s.tokens, 0);
  if (pauseMs > 0) s.pausedUntil = Math.max(s.pausedUntil, Date.now() + pauseMs);
}

/** Additive recovery after a success. */
export function reward(url) {
  if (!isLimitedPublicUrl(url)) return;
  const s = stateFor(url);
  if (s.rps < s.baseRps) s.rps = Math.min(s.baseRps, s.rps + s.baseRps * 0.05);
}

/**
 * Retry-After in ms (delta-seconds or HTTP-date), or null when absent/unparseable.
 * `0` is returned as 0 — the caller applies its own floor.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n * 1000));
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * Exponential backoff with full jitter, never below `floorMs`, never below the
 * server's Retry-After, capped at `capMs`.
 */
export function backoffMs(attempt, { baseMs = 1000, capMs = 60_000, floorMs = 500, retryAfterMs = null, random = Math.random } = {}) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jittered = floorMs + random() * Math.max(0, exp - floorMs);
  return Math.min(capMs, Math.max(jittered, retryAfterMs ?? 0, floorMs));
}

/** Smallest eth_getLogs span we bisect a limited host down to. */
export function minSplitBlocks(url) {
  const env = Number(process.env.RPC_MIN_SPLIT_BLOCKS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const l = limitsFor(url);
  return Number(l?.minSplitBlocks) >= 1 ? Math.floor(Number(l.minSplitBlocks)) : 10;
}

/** Hard eth_getLogs block-range cap configured for the URL's host (maxBlockRange), or null. */
export function hostMaxBlockRange(url) {
  const n = Number(limitsFor(url)?.maxBlockRange);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/** Test hook. */
export function __resetLimiterForTests() {
  states.clear();
  config = null;
}
