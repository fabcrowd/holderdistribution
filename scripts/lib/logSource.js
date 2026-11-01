// Source switch for the wallet-flow log scans. `rpc` (default) is the original
// eth_getLogs path, moved verbatim from generate-wallet-flows.js. `portal` streams
// the same logs from SQD Portal, but only for scans the caller marks allowPortal:
// those carry public token addresses and topic0 only, so no wallet list leaves RPC.

import process from "node:process";
import { PortalError, chainToDataset, streamLogs } from "./portalLogs.js";

export const SOURCES = Object.freeze(["rpc", "portal"]);
const RPC = "rpc";
const PORTAL = "portal";
const SOURCE_FLAG = "--source";
const SOURCE_ENV = "HD_BACKFILL_SOURCE";
const MAX_REQUESTS_ENV = "PORTAL_MAX_REQUESTS";
const DEFAULT_MAX_REQUESTS = 200;

/** Blocks held back from the head so Portal data is not read near a reorg (decision D6). */
export const DEFAULT_CONFIRMATIONS = Object.freeze({ ethereum: 64, polygon: 128, base: 64 });

const hex = (n) => "0x" + n.toString(16);

function assertSource(value, origin) {
  if (!SOURCES.includes(value)) {
    throw new Error(`${origin}: unknown log source "${value}" (expected one of: ${SOURCES.join(", ")})`);
  }
  return value;
}

function sourceFromArgv(argv) {
  const i = argv.indexOf(SOURCE_FLAG);
  if (i >= 0) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${SOURCE_FLAG} needs a value (rpc or portal)`);
    return value;
  }
  const inline = argv.find((a) => a.startsWith(`${SOURCE_FLAG}=`));
  return inline === undefined ? undefined : inline.slice(SOURCE_FLAG.length + 1);
}

/** Flag beats env, env beats the `rpc` default. Unknown values throw. */
export function parseSource({ argv = [], env = process.env } = {}) {
  const fromFlag = sourceFromArgv(argv);
  if (fromFlag !== undefined) return assertSource(fromFlag, SOURCE_FLAG);
  const fromEnv = env[SOURCE_ENV];
  if (fromEnv === undefined || fromEnv === "") return RPC;
  return assertSource(fromEnv, SOURCE_ENV);
}

function parsePositiveInt(raw, name, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

export function portalMaxRequests(env = process.env) {
  const value = parsePositiveInt(env[MAX_REQUESTS_ENV], MAX_REQUESTS_ENV, DEFAULT_MAX_REQUESTS);
  if (value < 1) throw new Error(`${MAX_REQUESTS_ENV} must be at least 1`);
  return value;
}

export function confirmationsFor(chain, env = process.env) {
  const fallback = DEFAULT_CONFIRMATIONS[chain];
  if (fallback === undefined) throw new Error(`no confirmation depth for chain "${chain}"`);
  return parsePositiveInt(env[`PORTAL_CONFIRMATIONS_${chain.toUpperCase()}`], `PORTAL_CONFIRMATIONS_${chain.toUpperCase()}`, fallback);
}

function assertTopic0Only(topics) {
  const extra = (topics ?? []).slice(1).filter((t) => t != null);
  if (extra.length > 0) {
    throw new Error("Portal scans may filter on topic0 only; sender or owner topics stay on RPC (decision D2)");
  }
}

function createRequestBudget(max) {
  let used = 0;
  return () => {
    used += 1;
    if (used > max) {
      throw new PortalError(`Portal request cap reached (${MAX_REQUESTS_ENV}=${max}); raise it or narrow the window`);
    }
  };
}

async function scanOnRpc(cfg, filterBase, from, to) {
  const ranges = [];
  for (let a = from; a <= to; a += cfg.span) ranges.push([a, Math.min(a + cfg.span - 1, to)]);
  const parts = await cfg.pool(ranges, Math.min(4, cfg.urls.length * 2), ([a, b], i) =>
    cfg.failover(cfg.urls, i % cfg.urls.length, { ...filterBase, fromBlock: hex(a), toBlock: hex(b) }),
  );
  return parts.flat();
}

function createPortalScan(cfg) {
  if (!Number.isInteger(cfg.head)) throw new Error("Portal scans need the chain head to place the end block");
  const endBlock = cfg.head - confirmationsFor(cfg.chain, cfg.env);
  const onRequest = createRequestBudget(portalMaxRequests(cfg.env));
  return async (filterBase, from, to) => {
    assertTopic0Only(filterBase.topics);
    if (!filterBase.address?.length) throw new Error("Portal scans need an explicit address list");
    const toBlock = Math.min(to, endBlock);
    if (from > toBlock) return [];
    return cfg.streamLogsImpl({
      dataset: chainToDataset(cfg.chain),
      fromBlock: from,
      toBlock,
      address: filterBase.address,
      topics: filterBase.topics ?? [],
      onRequest,
      fetchImpl: cfg.fetchImpl,
    });
  };
}

/**
 * Returns `{ source, scan(filterBase, from, to, { allowPortal }) }`. `scan` resolves to
 * RPC-shaped logs. Portal is used only when the source is `portal` AND allowPortal is set.
 */
export function createLogScanner(opts) {
  const source = assertSource(opts.source ?? RPC, "createLogScanner");
  const cfg = { ...opts, env: opts.env ?? process.env, streamLogsImpl: opts.streamLogsImpl ?? streamLogs };
  const scanRpc = (filterBase, from, to) => scanOnRpc(cfg, filterBase, from, to);
  if (source === RPC) {
    return { source, scan: (filterBase, from, to) => scanRpc(filterBase, from, to) };
  }
  const scanPortal = createPortalScan(cfg);
  return {
    source,
    scan: (filterBase, from, to, { allowPortal = false } = {}) =>
      allowPortal ? scanPortal(filterBase, from, to) : scanRpc(filterBase, from, to),
  };
}
