/**
 * Mirror node REST client: rate-limited, retrying, exact on big integers.
 * Public mainnet mirror (no key) is documented at 50 requests/second per IP.
 */
import { backoffMs, parseRetryAfter } from "../rpcLimiter.js";

export const HEDERA_MAINNET_MIRROR = "https://mainnet-public.mirrornode.hedera.com/api/v1";
/** Request starts per second. The documented public limit is 50 per IP; a shared CI IP needs headroom. */
export const HEDERA_MAX_RPS = 30;
export const HEDERA_MAX_ATTEMPTS = 6;
/** Per request, and again for reading the body. A stalled mirror is a retryable failure, never a hang. */
export const HEDERA_REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE = (status) => status === 429 || status >= 500;

/**
 * JSON.parse with the big-integer fields kept as exact strings. Tinybar values
 * exceed 2^53 (the 50B HBAR supply is 5e18), so a plain parse would round them.
 */
export function parseExactJson(text) {
  return JSON.parse(text.replace(/"(balance|total_supply|released_supply|amount)"\s*:\s*(-?\d+)/g, '"$1":"$2"'));
}

/** Rejects when `promise` has not settled within `ms`. */
function within(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMirrorClient({
  baseUrl = HEDERA_MAINNET_MIRROR,
  fetch: fetchImpl = globalThis.fetch,
  sleep = sleepReal,
  now = Date.now,
  maxRps = HEDERA_MAX_RPS,
  maxAttempts = HEDERA_MAX_ATTEMPTS,
  timeoutMs = HEDERA_REQUEST_TIMEOUT_MS,
  random = Math.random,
} = {}) {
  const root = baseUrl.replace(/\/+$/, "");
  const intervalMs = 1000 / maxRps;
  let nextStart = 0;

  // Reserve the next start slot synchronously so concurrent callers are spaced, never bunched.
  async function acquire() {
    const t = now();
    const start = Math.max(t, nextStart);
    nextStart = start + intervalMs;
    if (start > t) await sleep(start - t);
  }

  async function attemptOnce(url, passStatus) {
    let res;
    try {
      res = await within(Promise.resolve(fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })), timeoutMs, "request");
    } catch (e) {
      return { retry: true, error: `network error: ${e?.message ?? e}` };
    }
    if (!res.ok) {
      const error = `HTTP ${res.status}`;
      if (passStatus.includes(res.status)) return { body: null, status: res.status, clusterId: res.headers?.get?.("x-cluster-id") ?? null };
      if (!RETRYABLE(res.status)) throw new Error(`mirror GET ${url}: ${error}`);
      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers?.get?.("retry-after"), now()) : null;
      return { retry: true, error, retryAfterMs, throttled: res.status === 429 };
    }
    try {
      const body = parseExactJson(await within(Promise.resolve(res.text()), timeoutMs, "body read"));
      return { body, clusterId: res.headers?.get?.("x-cluster-id") ?? null };
    } catch (e) {
      return { retry: true, error: `unreadable body: ${e?.message ?? e}` };
    }
  }

  /**
   * GET `pathAndQuery` (starting with "/") and return { body, clusterId }. Retries, then throws; never partial.
   * mainnet-public load-balances independent mirror clusters that write snapshots on their own grids;
   * `x-cluster-id` says which one answered (null when the header is absent). A status in `passStatus` is returned
   * as { body: null, status, clusterId } instead of throwing; every other non-retryable status still throws.
   */
  async function getPage(pathAndQuery, { passStatus = [] } = {}) {
    const url = `${root}${pathAndQuery}`;
    let last = "";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await acquire();
      const r = await attemptOnce(url, passStatus);
      if (!r.retry) return { body: r.body, clusterId: r.clusterId, ...(r.status ? { status: r.status } : {}) };
      last = r.error;
      if (attempt < maxAttempts - 1) {
        const wait = backoffMs(attempt, { retryAfterMs: r.retryAfterMs ?? null, random });
        // A 429 is the server pushing back on the whole IP: hold every lane, not just this one.
        if (r.throttled) nextStart = Math.max(nextStart, now() + wait);
        await sleep(wait);
      }
    }
    throw new Error(`mirror GET ${url} failed after ${maxAttempts} attempts: ${last}`);
  }

  /** Body only, for endpoints where the answering cluster does not matter. */
  const getJson = async (pathAndQuery) => (await getPage(pathAndQuery)).body;

  return { baseUrl: root, getJson, getPage };
}
