/**
 * alchemyTransfers.js
 *
 * Client for Alchemy's `alchemy_getAssetTransfers` — a decoded, cursor-paginated
 * transfer-history endpoint, used in place of raw `eth_getLogs` for the
 * historical rebuild (scripts/rebuild-history-from-logs.js).
 *
 * WHY THIS REPLACES eth_getLogs FOR THE REBUILD
 *
 * `eth_getLogs` is capped per call (2,000 blocks on Polygon here — see
 * pull-holders-rpc.js's CHAIN_RPC_SETTINGS), so covering a multi-year range
 * means tens of thousands of chunked requests, each waiting on that chain's
 * rate limit. `alchemy_getAssetTransfers` has no per-call block-range limit
 * (default range is genesis-to-latest) and paginates via an opaque `pageKey`
 * cursor instead — the same total data, dramatically fewer round trips, and
 * it returns already-decoded transfer objects instead of raw log topics/data.
 *
 * Response shape includes BOTH a pre-decoded `value` (float, Alchemy's own
 * decimals() read) and `rawContract.value` (raw hex integer) +
 * `rawContract.decimal` (hex decimals). This module deliberately uses the RAW
 * hex value, parsed as BigInt, and lets the caller apply TEL's own known
 * decimals (2, established throughout this codebase) — the same BigInt-exact
 * approach parseTransfer() uses in pull-holders-rpc.js, avoiding float
 * precision drift and keeping one single source of truth for TEL's decimals
 * rather than trusting two different decimal reads to agree.
 *
 * TRADEOFF, STATED PLAINLY: pageKey pagination is sequential WITHIN one query
 * — page N+1's key comes from page N's response, so it cannot be parallelized
 * the way independent block-range chunks can. The rebuild script still shards
 * work across multiple RPC keys by giving each key a disjoint block range;
 * within each shard, this client removes the per-call range cap entirely.
 */

import { setTimeout as delay } from "node:timers/promises";

const CATEGORY = ["erc20"];
const MAX_COUNT_HEX = "0x3e8"; // 1000, Alchemy's per-page maximum

const toHexBlock = (block) => (typeof block === "number" ? "0x" + block.toString(16) : block);

/** Raw JSON-RPC call to alchemy_getAssetTransfers. Exported separately from
 *  the paginating wrapper so tests can supply a fake single-page fetcher.
 *
 *  Alchemy signals rate limiting via a 200-status JSON-RPC error body (not an
 *  HTTP 429), so treating any `json.error` as immediately fatal — which this
 *  function did until a live rebuild run hit "Rate limit exceeded" after
 *  375,000 transfers on a single-key Ethereum shard and died outright —
 *  throws away real progress on exactly the error this endpoint is expected
 *  to produce under sustained use. Retries with exponential backoff on a
 *  transient message; anything else (bad params, auth failure) still throws
 *  immediately, matching scripts/lib/etherscanMultiKey.js's already-fixed
 *  version of this same mistake for the Etherscan side. */
const TRANSIENT_MESSAGE_SUBSTRINGS = ["rate limit", "timeout", "too many requests", "try again"];
// A live rebuild run under sustained 3-shard-parallel load exhausted 6
// retries (~63s of total backoff, doubling with no cap) and gave up while
// each shard was already past 1.3M transfers fetched — the retry loop had
// also never logged anything per attempt, so there was no way to tell
// whether that was a brief blip or a genuinely longer throttle window that
// needed more patience. Widened to 12 retries with backoff capped at 60s
// (~9 minutes of total patience) and every attempt now logs the error that
// triggered it, so a future exhaustion is diagnosable instead of a bare
// "exceeded N retries."
const MAX_RETRIES = 12;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 60_000;
const retryDelayMs = (attempt) => Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);

const isTransientAlchemyError = (message) => {
  const text = (message ?? "").toLowerCase();
  return TRANSIENT_MESSAGE_SUBSTRINGS.some((needle) => text.includes(needle));
};

export const callGetAssetTransfers = async (rpcUrl, params, fetchImpl = fetch, delayImpl = delay) => {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let json;
    try {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [params] }),
      });
      json = await response.json();
    } catch (networkError) {
      // A dropped connection or truncated response body — a live rebuild run
      // hit "Unexpected end of JSON input" from response.json() after
      // 400,000+ transfers on one shard under sustained parallel load, a
      // different layer entirely from the JSON-RPC error object handled
      // below. Retried the same way rather than losing everything fetched
      // so far on this shard.
      lastError = `network error: ${networkError.message}`;
      if (attempt === MAX_RETRIES) break;
      const wait = retryDelayMs(attempt);
      console.warn(`  alchemy_getAssetTransfers ${lastError} — retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await delayImpl(wait);
      continue;
    }

    if (!json.error) return json.result;

    const message = json.error.message ?? JSON.stringify(json.error);
    // A non-transient error (bad params, auth) is fatal regardless of budget
    // — surface its real message immediately rather than masking it behind
    // retries that can't possibly help.
    if (!isTransientAlchemyError(message)) throw new Error(`alchemy_getAssetTransfers: ${message}`);
    lastError = message;
    if (attempt === MAX_RETRIES) break; // budget exhausted — fall through below
    const wait = retryDelayMs(attempt);
    console.warn(`  alchemy_getAssetTransfers "${message}" — retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await delayImpl(wait);
  }
  throw new Error(`alchemy_getAssetTransfers: exceeded ${MAX_RETRIES} retries on transient errors — last: ${lastError}`);
};

/**
 * Normalizes one Alchemy transfer object into the `{ from, to, value,
 * blockNumber }` shape the rest of the replay pipeline expects (matching
 * parseTransferLog's output in pull-holders-rpc.js, plus a `blockNumber`
 * field so scripts/lib/historicalReplay.js's `partitionLogsByBoundary` can
 * order and bucket these exactly like raw logs, unchanged).
 *
 * Returns null for a transfer this module shouldn't count: zero-address legs
 * (mint/burn, no holder on that side) are nulled out per-field rather than
 * dropped entirely, matching rebuild-history-from-logs.js's own
 * parseTransfer() convention.
 */
export const normalizeTransfer = (transfer) => {
  const rawValue = transfer?.rawContract?.value;
  const blockNum = transfer?.blockNum;
  if (typeof rawValue !== "string" || typeof blockNum !== "string") return null;

  let value;
  try {
    value = BigInt(rawValue);
  } catch {
    return null;
  }

  const from = typeof transfer?.from === "string" ? transfer.from.toLowerCase() : null;
  const to = typeof transfer?.to === "string" ? transfer.to.toLowerCase() : null;
  const ZERO = "0x0000000000000000000000000000000000000000";

  // transactionHash is carried through deliberately. generate-tier-outflows.js
  // needs it to fetch a receipt and split dexSwap vs dexLp, and without it a
  // cached transfer cannot serve that consumer — which is why the transfer
  // caches could not previously be shared and every block range ended up being
  // fetched once per script. Rows written before this field existed simply
  // lack it, so a reader must treat a missing hash as "not usable for receipt
  // classification" and fall back to a live fetch rather than silently
  // downgrading the split. See tasks/rpc-dedup-design.md.
  const txHash = typeof transfer?.hash === "string" ? transfer.hash : null;

  return {
    from: from === ZERO ? null : from,
    to: to === ZERO ? null : to,
    value,
    blockNumber: blockNum,
    transactionHash: txHash,
  };
};

/**
 * Fetches every ERC-20 transfer for `contractAddress` between `fromBlock` and
 * `toBlock` (inclusive), following `pageKey` until exhausted, and returns
 * normalized `{ from, to, value, blockNumber }` records ready for
 * `partitionLogsByBoundary`.
 *
 * `onPage(count, pageKey)` is an optional progress callback — useful for
 * checkpointing between pages on a long-running scan, since a crash mid-scan
 * should resume from the last completed page, not from `fromBlock`.
 */
export const fetchAllTransfers = async (
  rpcUrl,
  { fromBlock, toBlock, contractAddress, resumePageKey = null, onPage, fetchImpl = fetch },
) => {
  const results = [];
  let pageKey = resumePageKey;

  do {
    const page = await callGetAssetTransfers(
      rpcUrl,
      {
        fromBlock: toHexBlock(fromBlock),
        toBlock: toHexBlock(toBlock),
        contractAddresses: [contractAddress],
        category: CATEGORY,
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: MAX_COUNT_HEX,
        ...(pageKey ? { pageKey } : {}),
      },
      fetchImpl,
    );

    const transfers = Array.isArray(page?.transfers) ? page.transfers : [];
    for (const transfer of transfers) {
      const normalized = normalizeTransfer(transfer);
      if (normalized) results.push(normalized);
    }

    pageKey = page?.pageKey ?? null;
    if (onPage) await onPage(results.length, pageKey);
  } while (pageKey);

  return results;
};
