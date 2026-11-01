// Completeness gate for Portal-sourced logs. Portal can end a stream without an error and
// return fewer logs than the chain has, so before any Portal-sourced output is written we
// compare `transactionHash:logIndex` key sets against RPC eth_getLogs on a few sampled windows.
// Any missing or extra key fails the gate. Only callers that already sent the same
// public-token, topic0-only filter to Portal use this, so no wallet list is involved.

const DEFAULT_BLOCKS = 5000;
const DEFAULT_WINDOWS = 6;
const LISTED_KEYS = 5;
const BLOCKS_ENV = "PORTAL_COMPLETENESS_BLOCKS";
const WINDOWS_ENV = "PORTAL_COMPLETENESS_WINDOWS";

export class PortalCompletenessError extends Error {
  constructor(message, { chain, missingCount = 0, extraCount = 0, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PortalCompletenessError";
    this.chain = chain;
    this.missingCount = missingCount;
    this.extraCount = extraCount;
  }
}

function readPositiveInt(raw, name, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Sample size from env (`PORTAL_COMPLETENESS_BLOCKS`, `PORTAL_COMPLETENESS_WINDOWS`).
 * `maxWindow` (the chain's log span) caps the window size; the span is an upper bound.
 */
export function completenessSampleConfig(env = process.env, maxWindow = Infinity) {
  const blocks = readPositiveInt(env[BLOCKS_ENV], BLOCKS_ENV, DEFAULT_BLOCKS);
  const windows = readPositiveInt(env[WINDOWS_ENV], WINDOWS_ENV, DEFAULT_WINDOWS);
  return { blocks: Math.max(1, Math.min(blocks, maxWindow)), windows };
}

const toNumber = (value) => (typeof value === "number" ? value : Number.parseInt(value, 16));

/** Key for set comparison; hex or decimal logIndex and any hash case compare equal. */
export function logKey(log) {
  return `${String(log.transactionHash).toLowerCase()}:${toNumber(log.logIndex)}`;
}

const inWindow = (log, win) => {
  const n = toNumber(log.blockNumber);
  return n >= win.from && n <= win.to;
};

/**
 * Evenly spaced windows of `blocks` blocks across [fromBlock, toBlock]: the first one at
 * the start and, for two or more, the last one at the end. Duplicates collapse.
 */
export function sampleWindows(fromBlock, toBlock, { blocks, windows }) {
  if (toBlock < fromBlock) return [];
  const span = toBlock - fromBlock + 1;
  const size = Math.min(blocks, span);
  const slack = span - size;
  const starts = Array.from({ length: Math.max(1, windows) }, (_, i) =>
    windows <= 1 ? fromBlock : fromBlock + Math.round((i * slack) / (windows - 1)),
  );
  return [...new Set(starts)].map((from) => ({ from, to: from + size - 1 }));
}

/** Set difference both ways over log keys. Both inputs are assumed already windowed. */
export function compareLogSets(portalLogs, rpcLogs) {
  const portal = new Set(portalLogs.map(logKey));
  const rpc = new Set(rpcLogs.map(logKey));
  return {
    portalCount: portalLogs.length,
    rpcCount: rpcLogs.length,
    missing: [...rpc].filter((k) => !portal.has(k)),
    extra: [...portal].filter((k) => !rpc.has(k)),
  };
}

async function fetchWindowFromRpc({ chain, urls, failover, preferredIdx, filterBase, win }) {
  const filter = { ...filterBase, fromBlock: `0x${win.from.toString(16)}`, toBlock: `0x${win.to.toString(16)}` };
  try {
    return await failover(urls, preferredIdx, filter);
  } catch (cause) {
    throw new PortalCompletenessError(
      `RPC getLogs failed for ${chain} sample window ${win.from}-${win.to}; completeness not verified`,
      { chain, cause },
    );
  }
}

function sumField(results, field) {
  return results.reduce((total, r) => total + r[field], 0);
}

/**
 * Compares Portal logs (already fetched for the whole range) with RPC on sampled windows.
 * `fromBlock`/`toBlock` must be the range Portal actually scanned (after confirmations).
 * Resolves `{ ok, ... }` for both a match and a mismatch; RPC failures throw
 * PortalCompletenessError so a failed check can never read as ok.
 */
export async function verifyPortalCompleteness({
  chain,
  urls,
  filterBase,
  portalLogs,
  fromBlock,
  toBlock,
  failover,
  preferredIdx = 0,
  sample,
  maxWindow,
}) {
  const base = sample ?? completenessSampleConfig(process.env);
  const windows = sampleWindows(fromBlock, toBlock, { ...base, blocks: Math.min(base.blocks, maxWindow ?? Infinity) });
  const results = [];
  for (const win of windows) {
    const rpcLogs = (await fetchWindowFromRpc({ chain, urls, failover, preferredIdx, filterBase, win })).filter((l) => inWindow(l, win));
    const portalInWindow = portalLogs.filter((l) => inWindow(l, win));
    results.push({ window: win, ...compareLogSets(portalInWindow, rpcLogs) });
  }
  const missing = results.flatMap((r) => r.missing);
  const extra = results.flatMap((r) => r.extra);
  const missingCount = missing.length;
  const extraCount = extra.length;
  return {
    ok: missingCount === 0 && extraCount === 0,
    chain,
    windows: results.map(({ window, portalCount, rpcCount, missing: m, extra: e }) => ({
      from: window.from,
      to: window.to,
      portalCount,
      rpcCount,
      missingCount: m.length,
      extraCount: e.length,
    })),
    portalCount: sumField(results, "portalCount"),
    rpcCount: sumField(results, "rpcCount"),
    missingCount,
    extraCount,
    missing: missing.slice(0, LISTED_KEYS),
    extra: extra.slice(0, LISTED_KEYS),
  };
}

/** Throws unless the check passed. The message carries the chain and counts only, never keys. */
export function assertPortalComplete(result) {
  if (result.ok) return result;
  throw new PortalCompletenessError(
    `Portal completeness check failed on ${result.chain}: ${result.missingCount} missing, ${result.extraCount} extra log(s) vs RPC; output not written`,
    { chain: result.chain, missingCount: result.missingCount, extraCount: result.extraCount },
  );
}

/** One-line summary for the run log. */
export function describeCompleteness(result) {
  const windowCount = result.windows.length;
  if (result.ok) {
    return `${result.chain}: portal completeness ok (${result.rpcCount} keys, ${windowCount} sampled windows)`;
  }
  return `${result.chain}: portal completeness FAILED (${result.missingCount} missing, ${result.extraCount} extra, ${windowCount} sampled windows)`;
}
