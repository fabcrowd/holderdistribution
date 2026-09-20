import process from "node:process";

const RPC_KEYS_BY_CHAIN = {
  ethereum: ["ETH_RPC_0", "ETH_RPC_1", "ETH_RPC_2", "ETH_RPC_3", "ETH_RPC_4", "ETH_RPC_5", "ETH_RPC_6", "ETH_RPC_7", "ETH_RPC_8", "ETH_RPC_9"],
  polygon: ["MATIC_RPC_0", "MATIC_RPC_1", "MATIC_RPC_2", "MATIC_RPC_3", "MATIC_RPC_4", "MATIC_RPC_5", "MATIC_RPC_6", "MATIC_RPC_7", "MATIC_RPC_8", "MATIC_RPC_9"],
  base: ["BASE_RPC_0", "BASE_RPC_1", "BASE_RPC_2", "BASE_RPC_3", "BASE_RPC_4", "BASE_RPC_5", "BASE_RPC_6", "BASE_RPC_7", "BASE_RPC_8", "BASE_RPC_9"],
};

function getFirstRpcUrl(keys) {
  for (const key of keys) {
    const url = process.env[key];
    if (typeof url === "string" && url.trim().length > 0) {
      return url.trim().replace(/\/+$/, "");
    }
  }
  return null;
}

/**
 * Returns all available RPC URLs for the given chain, in declaration order.
 * Use this when you want to parallelise requests across multiple Alchemy keys.
 * @returns {string[]}
 */
export function getAllRpcUrls(chainKey) {
  const keys = RPC_KEYS_BY_CHAIN[chainKey];
  if (!keys) return [];
  return keys
    .map((k) => process.env[k])
    .filter((url) => typeof url === "string" && url.trim().length > 0)
    .map((url) => url.trim().replace(/\/+$/, ""));
}

/**
 * The configured pool minus the keys that are not answering right now.
 *
 * Every key the project has ever been given stays in .env.enc, because a key
 * that is dead today is usually just an account over its monthly quota and
 * comes back on its own at the reset. Handing those to a scan anyway is what
 * makes a large pool dangerous rather than useful: the multi-key consumers
 * shard a block range across ALL urls, one contiguous sub-range per url, so a
 * shard assigned to a dead key fails that whole sub-range after burning a
 * five-attempt exponential backoff — 19 keys where 14 are dead is far worse
 * than 5 good ones. Probing first gets both: nothing is lost from the config,
 * and nothing dead reaches a scan.
 *
 * One eth_blockNumber per url, in parallel, no retries (a key that needs a
 * retry to answer a trivial call is not one to hand a scan shard to). Result
 * is cached per process, so the cost is a single round trip per chain per run.
 * Order is preserved, so slot 0 stays the first HEALTHY key for the callers
 * that take just one.
 */
const usableUrlCache = new Map();

export async function getUsableRpcUrls(chainKey, { logger = console } = {}) {
  if (usableUrlCache.has(chainKey)) return usableUrlCache.get(chainKey);

  const configured = getAllRpcUrls(chainKey);
  if (configured.length === 0) {
    usableUrlCache.set(chainKey, []);
    return [];
  }

  const results = await Promise.all(
    configured.map(async (url) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.error) {
          return { url, ok: false, reason: body?.error?.message ?? `HTTP ${response.status}` };
        }
        return { url, ok: true };
      } catch (error) {
        return { url, ok: false, reason: error?.message ?? String(error) };
      }
    }),
  );

  const usable = results.filter((r) => r.ok).map((r) => r.url);
  const dead = results.filter((r) => !r.ok);
  // Logged every run: which keys carried the work, and why the others sat out.
  // Without this a shrinking pool is invisible until it reaches zero.
  logger.log(
    `RPC pool ${chainKey}: ${usable.length}/${configured.length} usable` +
      (dead.length ? ` — skipping ${dead.map((d) => `…${d.url.slice(-4)} (${shortReason(d.reason)})`).join(", ")}` : ""),
  );
  if (usable.length === 0) {
    throw new Error(
      `No usable RPC URLs for ${chainKey}: all ${configured.length} configured key(s) failed a ` +
        `single eth_blockNumber. First reason: ${dead[0]?.reason ?? "unknown"}`,
    );
  }
  usableUrlCache.set(chainKey, usable);
  return usable;
}

const shortReason = (reason) =>
  /monthly capacity/i.test(reason ?? "")
    ? "monthly quota"
    : String(reason ?? "unknown").slice(0, 40);

const PROBE_TIMEOUT_MS = Number(process.env.RPC_PROBE_TIMEOUT_MS) || 10000;

/**
 * @returns {string|null} First available Polygon RPC URL from env. Alchemy PAYG: eth_getLogs max 2000 blocks.
 */
export function getPolygonRpcUrl() {
  return getFirstRpcUrl(RPC_KEYS_BY_CHAIN.polygon);
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

// No timeout used to be set on the fetch below, so a provider that accepted a
// connection and then stopped responding hung the whole run indefinitely — not
// a crash, just a job sitting at 0% CPU with no open socket and no output. That
// is exactly how a full-history Base rescan stalled after ~30 minutes. A hung
// request is a transient network failure like any other, so it now aborts and
// goes through the same retry ladder instead of blocking forever.
const REQUEST_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS) || 30000;

function isRetryableNetworkError(err) {
  const msg = (err && err.message) || "";
  const cause = err && err.cause;
  const code = cause && cause.code;
  return (
    msg.includes("fetch failed") ||
    // AbortSignal.timeout() surfaces as a TimeoutError DOMException; older
    // aborts surface as AbortError. Both mean "no answer", so both retry.
    err?.name === "TimeoutError" ||
    err?.name === "AbortError" ||
    msg.includes("timed out") ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED"
  );
}

/**
 * Call JSON-RPC method on the given RPC URL.
 * @param {string} rpcUrl
 * @param {string} method
 * @param {unknown[]} params
 * @param {number} attempt
 * @returns {Promise<unknown>}
 */
export async function rpcCall(rpcUrl, method, params = [], attempt = 0) {
  let response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
  } catch (err) {
    if (isRetryableNetworkError(err) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      return rpcCall(rpcUrl, method, params, attempt + 1);
    }
    throw err;
  }
  if (!response.ok) {
    // 403 alongside 429 as retryable: a live rebuild run hit "RPC HTTP 403:
    // Forbidden" from Alchemy mid-scan, after many hundreds of successful
    // prior calls on the same key — consistent with a quota/CU cap kicking
    // in rather than a genuinely invalid key (which would 403 immediately,
    // not after sustained successful use). Bounded by the same MAX_RETRIES,
    // so a truly bad key still surfaces the error instead of retrying
    // forever.
    //
    // 502/503/504 are the provider's own transient-failure vocabulary
    // (Bad Gateway / Service Unavailable / Gateway Timeout) — a multi-day
    // free-tier catch-up run hit a bare 503 ("Unable to complete request at
    // this time") after ~20 minutes of otherwise-healthy 10-block-chunk
    // scanning across all three chains. It wasn't retried, so it threw,
    // which (via the un-isolated Promise.all in main() below) killed every
    // chain's in-progress scan — including two chains that had nothing to
    // do with the failing request. Retrying these here, same backoff and
    // bound as 429/403, is strictly safer than treating a transient
    // "try again" from the provider as fatal.
    if ((response.status === 429 || response.status === 403 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.ceil(Number(retryAfter) * 1000)
        : RETRY_DELAY_MS * 2 ** attempt;
      console.warn(`HTTP ${response.status}. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES}).`);
      await new Promise((r) => setTimeout(r, waitMs));
      return rpcCall(rpcUrl, method, params, attempt + 1);
    }
    // Alchemy's 400s carry a structured JSON-RPC error body (e.g. a free-tier
    // eth_getLogs block-range rejection) that response.statusText alone
    // discards — read it so getLogs() below can act on the actual reason,
    // and so a human reading the thrown error isn't stuck guessing why.
    let bodyText = "";
    try { bodyText = await response.text(); } catch { /* body already consumed or unreadable */ }
    throw new Error(`RPC HTTP ${response.status}: ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`);
  }
  const data = await response.json();
  if (data.error) {
    if (data.error.code === -32005 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return rpcCall(rpcUrl, method, params, attempt + 1);
    }
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data.result;
}

// Matches Alchemy's free-tier eth_getLogs rejection, e.g. "Under the Free
// tier plan, you can make eth_getLogs requests with up to a 10 block range."
// A daily-catchup run hit this on ETH_RPC_0 — a key that had been running
// fine on chunked 10,000-block requests for weeks — because it's the same
// paid key the user reported as CU-exhausted; Alchemy evidently drops a
// CU-exhausted key to free-tier behavior rather than just rate-limiting it,
// which a plain "retry the same request" can never recover from.
const FREE_TIER_RANGE_PATTERN = /up to an?\s+(\d+)\s+block range/i;

/**
 * Fetch logs (eth_getLogs) for a single block range. Self-adjusts to a
 * smaller range and retries when the provider rejects the requested span —
 * see FREE_TIER_RANGE_PATTERN — instead of failing a whole scan over a limit
 * discovered only by a caller who happened to be on the right tier when the
 * chunk size was originally chosen.
 * @param {string} rpcUrl
 * @param {{ fromBlock: string; toBlock: string; address: string; topics: string[] }} filter
 * @returns {Promise<{ address: string; topics: string[]; data: string }[]>}
 */
export async function getLogs(rpcUrl, filter) {
  try {
    const logs = await rpcCall(rpcUrl, "eth_getLogs", [filter]);
    return Array.isArray(logs) ? logs : [];
  } catch (err) {
    const match = FREE_TIER_RANGE_PATTERN.exec(err.message);
    if (!match) throw err;

    const allowedSpan = Number(match[1]);
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Number.parseInt(filter.toBlock, 16);
    if (!Number.isFinite(allowedSpan) || allowedSpan < 1 || !Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      throw err;
    }
    console.warn(`  eth_getLogs range too wide for this key's tier — retrying ${from}-${to} in ${allowedSpan}-block sub-chunks.`);

    const results = [];
    for (let start = from; start <= to; start += allowedSpan) {
      const end = Math.min(start + allowedSpan - 1, to);
      const subLogs = await getLogs(rpcUrl, {
        ...filter,
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
      });
      results.push(...subLogs);
    }
    return results;
  }
}
