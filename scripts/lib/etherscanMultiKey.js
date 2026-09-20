/**
 * etherscanMultiKey.js
 *
 * Etherscan v2 unified API client with a rate-limited round-robin key pool,
 * used as an INDEPENDENT cross-check against the Alchemy-derived rebuild
 * (scripts/rebuild-history-from-logs.js), never as a second data source
 * merged into the same balance ledger.
 *
 * WHY SEPARATE FROM THE REBUILD'S PRIMARY LEDGER
 *
 * Two providers can each be internally correct and still disagree at the
 * margins — decimal handling, internal-transfer inclusion, indexing lag. This
 * project's own precedent (scripts/verify-staker-methods.js) already answers
 * "which source do we trust": compute via two independent methods, COMPARE
 * them, and only then decide — never interleave rows from two sources into
 * one ledger, or a disagreement becomes silent corruption instead of a
 * visible mismatch. See scripts/cross-check-rebuild-etherscan.js for the
 * comparison itself; this module only fetches Etherscan's side of it.
 *
 * Etherscan v2's `chainid` query parameter means ONE key already covers
 * Ethereum, Polygon, and Base (unlike Alchemy, where every app is bound to a
 * single chain) — see config/chains.json for the chainId per chain key.
 *
 * Free-tier constraints, matching pull-staker-balances.js's already-tuned
 * values: 3 requests/sec per key (paced at 400ms to leave margin), and a
 * HARD 1000-row cap per page regardless of the `offset` value requested —
 * verified directly (requesting offset=10000 against a live key still
 * returned exactly 1000 rows with status "1"/"OK", not an error or a
 * shorter-than-requested-but-still-last page). pull-staker-balances.js's
 * PAGE_SIZE was already correctly set to 1000 for this reason; an earlier
 * version of this file used 10000, silently truncating any StakeChanged scan
 * past its first 1000 events — caught by a direct sanity check before it
 * reached the actual rebuild. Handled the same way as that script: advance
 * `startblock` to the last returned row's block after each full page.
 */

import { setTimeout as delay } from "node:timers/promises";

const PAGE_SIZE = 1000; // hard cap, see module header — NOT the 10000 you'd expect from "page*offset<=10000"
const DEFAULT_DELAY_MS = 400;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;

const normalizeAddress = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null;
};

/** Reads ETHERSCAN_API_KEY plus ETHERSCAN_API_KEY_1/2/3... from process.env,
 *  in that order, skipping unset ones. Matches this repo's existing single-key
 *  variable name so scripts that already read ETHERSCAN_API_KEY solo (e.g.
 *  pull-staker-balances.js) are unaffected — this just also picks up the
 *  numbered siblings when present. */
export const keysFromEnv = (env = process.env) => {
  const keys = [];
  if (env.ETHERSCAN_API_KEY) keys.push(env.ETHERSCAN_API_KEY);
  for (let i = 1; env[`ETHERSCAN_API_KEY_${i}`]; i++) keys.push(env[`ETHERSCAN_API_KEY_${i}`]);
  return keys;
};

/**
 * Round-robin dispatcher across `keys`, pacing each key INDEPENDENTLY at
 * `delayMs` — so N keys give up to N times the aggregate throughput of one,
 * rather than sharing a single global rate limit.
 */
export const createEtherscanKeyPool = (keys, { delayMs = DEFAULT_DELAY_MS, now = () => Date.now() } = {}) => {
  if (!keys.length) throw new Error("createEtherscanKeyPool: at least one key is required");
  const lastUsedAt = keys.map(() => -Infinity);
  let cursor = 0;

  return {
    size: keys.length,
    /** Waits until this call's assigned key is clear of its own rate limit,
     *  then returns that key. */
    async acquire() {
      const index = cursor;
      cursor = (cursor + 1) % keys.length;
      const wait = lastUsedAt[index] + delayMs - now();
      if (wait > 0) await delay(wait);
      lastUsedAt[index] = now();
      return keys[index];
    },
  };
};

const baseUrl = (env = process.env) => {
  const override = env.ETHERSCAN_API_BASE_URL?.trim();
  return override ? override.replace(/\/+$/, "") : "https://api.etherscan.io/v2/api";
};

/** HTTP statuses worth retrying rather than failing the whole scan.
 *  429 is the documented rate limit. 404 is NOT a missing resource here:
 *  Etherscan intermittently answers a perfectly valid v2 query with a 404 and
 *  an HTML error page — measured at 2 of 6 identical requests. Because a single
 *  such blip used to throw, one bad response killed an entire multi-wallet
 *  rescan minutes in, and the failure point moved between runs, which is what
 *  made it look request-specific rather than transient. 5xx is the same class.
 *  A genuinely wrong URL still fails, just after exhausting retries. */
const RETRYABLE_STATUSES = new Set([404, 429, 500, 502, 503, 504]);

const fetchWithRetry = async (url, attempt = 0, fetchImpl = fetch) => {
  const response = await fetchImpl(url);
  if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) : RETRY_BASE_DELAY_MS * 2 ** attempt;
    await delay(waitMs);
    return fetchWithRetry(url, attempt + 1, fetchImpl);
  }
  if (!response.ok) {
    // Include the URL (API key redacted) — a bare status code gives no way to
    // tell a bad request from a transient blip, which cost a full rescan once.
    const safeUrl = url.replace(/([?&]apikey=)[^&]*/i, "$1<redacted>");
    throw new Error(`Etherscan request failed: ${response.status} ${response.statusText} — ${safeUrl}`);
  }
  return response.json();
};

/** Etherscan signals failure two ways: an HTTP-level 429 (handled by
 *  fetchWithRetry above) and an HTTP-200 body with status "0" and a message
 *  string — which can mean "genuinely no more data" (terminal), "rate
 *  limited" or "server busy" (transient — retry the SAME page), or something
 *  actually wrong (fatal). Treating every non-"1" status as fatal, or every
 *  transient message as terminal, are both real bugs this project has hit:
 *  the free-tier response "Unexpected error, timeout or server too busy" is
 *  neither of the two messages this function used to special-case, and was
 *  killing an otherwise-recoverable scan outright. */
const NO_MORE_DATA_MESSAGES = new Set(["No transactions found", "No records found", "No data found"]);
const TRANSIENT_MESSAGE_SUBSTRINGS = ["rate limit", "timeout", "server too busy", "server error"];
const MAX_PAGE_RETRIES = 6;

const isTransientEtherscanMessage = (data) => {
  const text = `${data?.message ?? ""} ${typeof data?.result === "string" ? data.result : ""}`.toLowerCase();
  return TRANSIENT_MESSAGE_SUBSTRINGS.some((needle) => text.includes(needle));
};

/**
 * Fetches one Etherscan page via `pool`, retrying in place (same page,
 * exponential backoff) on a transient inline error, and returns either the
 * page's `result` array or `null` for "genuinely no more data" — the caller
 * loops on a non-null result and stops on null.
 */
export const fetchEtherscanPage = async (pool, buildUrl, fetchImpl) => {
  for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
    const apiKey = await pool.acquire();
    const data = await fetchWithRetry(buildUrl(apiKey), 0, fetchImpl);

    if (data.status === "1" && Array.isArray(data.result)) return data.result;
    if (NO_MORE_DATA_MESSAGES.has(data.message)) return null;
    if (isTransientEtherscanMessage(data)) {
      await delay(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`Etherscan API error: ${data.message ?? "unknown"} - ${JSON.stringify(data.result)}`);
  }
  throw new Error(`Etherscan API: exceeded ${MAX_PAGE_RETRIES} retries on transient errors`);
};

/** Normalizes one Etherscan tokentx row into the same `{ from, to, value,
 *  blockNumber }` shape alchemyTransfers.normalizeTransfer produces, so a
 *  comparison can diff them directly without a translation layer. */
export const normalizeTokenTx = (row) => {
  const from = normalizeAddress(row?.from);
  const to = normalizeAddress(row?.to);
  const blockNumber = row?.blockNumber;
  if (!blockNumber || (from === null && to === null)) return null;
  let value;
  try {
    value = BigInt(row.value);
  } catch {
    return null;
  }
  return { from, to, value, blockNumber: "0x" + Number(blockNumber).toString(16) };
};

/**
 * Fetches every ERC-20 transfer TOUCHING `address` for `contractAddress` on
 * `chainId`, between `startBlock` and `endBlock`, paginating via the
 * startblock-advance trick (page always 1, 1000-row hard cap per page).
 *
 * Scoped to one address deliberately — this is a cross-check tool for a
 * SAMPLE of addresses/dates against the rebuild, not a full independent
 * replay of the whole token's history (that 1000-row cap makes a full scan
 * of a busy contract impractical; Alchemy's getAssetTransfers has no such
 * ceiling, which is exactly why it's the rebuild's primary source).
 */
export const fetchAddressTransfers = async (
  pool,
  { chainId, address, contractAddress, startBlock = 0, endBlock = "latest", env = process.env, fetchImpl = fetch },
) => {
  const results = [];
  let cursor = startBlock;

  while (true) {
    const page = await fetchEtherscanPage(
      pool,
      (apiKey) =>
        `${baseUrl(env)}?chainid=${chainId}&module=account&action=tokentx` +
        `&address=${address}&contractaddress=${contractAddress}` +
        `&startblock=${cursor}&endblock=${endBlock}&page=1&offset=${PAGE_SIZE}&sort=asc` +
        `&apikey=${apiKey}`,
      fetchImpl,
    );
    if (page === null) break;

    for (const row of page) {
      const normalized = normalizeTokenTx(row);
      if (normalized) results.push(normalized);
    }

    if (page.length < PAGE_SIZE) break;
    cursor = Number(page[page.length - 1].blockNumber);
  }

  return results;
};

/**
 * Fetches every log matching `topic0` at `address` on `chainId`, between
 * `startBlock` and `endBlock`, paginating via the same startblock-advance
 * trick as fetchAddressTransfers. Returns raw Etherscan log rows (topics,
 * data, blockNumber as a hex string) rather than a normalized shape — this is
 * for arbitrary contract events (StakeChanged, not a token transfer), so the
 * caller supplies its own parser, same as it would for a raw eth_getLogs
 * response. Etherscan's getLogs rows are already in that standard shape,
 * confirmed by pull-staker-balances.js's fetchStakeChangedCandidates already
 * consuming them the same way in production.
 *
 * WHY THIS EXISTS ALONGSIDE ALCHEMY
 *
 * alchemy_getAssetTransfers has no per-call block-range limit on any tier
 * (verified directly against a free-tier key: a genesis-to-latest query
 * returned real data with no error). Free-tier Alchemy's plain eth_getLogs
 * does NOT share that — verified directly, every free-tier key here refuses
 * anything over a 10-block range. getAssetTransfers only covers token
 * transfers, not arbitrary events like StakeChanged, so staking replay needs
 * a getLogs-shaped source without that 10-block ceiling — Etherscan's is it.
 */
export const fetchContractLogs = async (
  pool,
  { chainId, address, topic0, topic1, topic2, topic3, startBlock = 0, endBlock = "latest", env = process.env, fetchImpl = fetch },
) => {
  const results = [];
  let cursor = startBlock;

  while (true) {
    const topicParams = [
      topic1 != null ? `&topic0_1_opr=and&topic1=${topic1}` : "",
      topic2 != null ? `&topic1_2_opr=and&topic2=${topic2}` : "",
      topic3 != null ? `&topic2_3_opr=and&topic3=${topic3}` : "",
    ].join("");

    const page = await fetchEtherscanPage(
      pool,
      (apiKey) =>
        `${baseUrl(env)}?chainid=${chainId}&module=logs&action=getLogs` +
        `&address=${address}&topic0=${topic0}${topicParams}` +
        `&fromBlock=${cursor}&toBlock=${endBlock}&page=1&offset=${PAGE_SIZE}` +
        `&apikey=${apiKey}`,
      fetchImpl,
    );
    if (page === null) break;

    results.push(...page);
    if (page.length < PAGE_SIZE) break;
    const lastBlock = Number(page[page.length - 1].blockNumber);
    if (lastBlock < cursor) break;
    cursor = lastBlock + 1;
  }

  return results;
};

/**
 * Nets `transfers` (as returned by fetchAddressTransfers or
 * alchemyTransfers.fetchAllTransfers) for one address, up to and including
 * `atBlock` — a pure function so the cross-check comparison is unit-testable
 * without any network access.
 */
export const balanceAtBlock = (transfers, address, atBlock) => {
  const target = typeof atBlock === "number" ? atBlock : Number(atBlock);
  let balance = 0n;
  for (const t of transfers) {
    const block = typeof t.blockNumber === "string" ? Number.parseInt(t.blockNumber, 16) : t.blockNumber;
    if (block > target) continue;
    if (t.to === address) balance += t.value;
    if (t.from === address) balance -= t.value;
  }
  return balance;
};

/**
 * eth_call via Etherscan v2 proxy module (read-only contract call).
 * @param {ReturnType<typeof createEtherscanKeyPool>} pool
 * @param {{ chainId: number, to: string, data: string }} params
 */
export const ethCall = async (pool, { chainId, to, data }, fetchImpl = fetch) => {
  const key = await pool.acquire();
  const url = `${baseUrl()}?chainid=${chainId}&module=proxy&action=eth_call&to=${to}&data=${data}&tag=latest&apikey=${key}`;
  const json = await fetchWithRetry(url, 0, fetchImpl);
  if (json.status === "0" && json.message !== "OK") {
    throw new Error(`eth_call failed: ${json.message} ${json.result ?? ""}`);
  }
  return json.result;
};

/** Decode Gnosis Safe getOwners() eth_call result → lowercase addresses. */
export const decodeSafeOwners = (hex) => {
  if (!hex || hex === "0x") return [];
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 128) return [];
  const length = Number.parseInt(raw.slice(64, 128), 16);
  /** @type {string[]} */
  const owners = [];
  for (let i = 0; i < length; i++) {
    const word = raw.slice(128 + i * 64, 128 + (i + 1) * 64);
    owners.push(`0x${word.slice(24)}`.toLowerCase());
  }
  return owners;
};
