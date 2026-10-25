/**
 * Solana JSON-RPC pool. Same rules as scripts/lib/rpc.js for EVM:
 *
 *   - Key pool: `<PREFIX>_RPC_0..9` where PREFIX = rpcEnvPrefix(chainKey)
 *     (chain key "solana" -> SOLANA_RPC_0..9; `chains[].rpc.envPrefix` overrides).
 *   - Public endpoints: PUBLIC_RPC_URLS_<CHAIN> env > `chains[].rpc.publicUrls`
 *     > the built-in https://api.mainnet-beta.solana.com.
 *     PUBLIC_RPC_FALLBACK=off removes them.
 *   - Order: public endpoints FIRST, then keys (the owner's call: free first,
 *     paid keys only add throughput / getProgramAccounts reach). RPC_PREFER_PUBLIC
 *     is therefore always effectively on for Solana.
 *
 * Health is getHealth (falls back to getSlot), one call per URL, no retries,
 * cached per process. Calls reuse rpc.js rpcCall (429/5xx backoff, timeouts).
 */
import process from "node:process";
import { configureProjectRpc, getAllRpcUrls, getPublicFallbackUrls, rpcCall } from "../rpc.js";

export const SOLANA_PUBLIC_RPC = Object.freeze(["https://api.mainnet-beta.solana.com"]);

const usableCache = new Map();

/**
 * Registers a Solana chain's `rpc` block (envPrefix / publicUrls) through the
 * same rpc.js configureProjectRpc() the EVM chains use. selectPipelineProject
 * already did this for the whole project; calling it again is idempotent.
 */
export function configureSolanaChain(chain) {
  if (chain?.key && chain?.rpc) configureProjectRpc({ chains: [chain] });
  usableCache.delete(chain?.key);
}

/**
 * Keyless endpoints: PUBLIC_RPC_URLS_<CHAIN> > chains[].rpc.publicUrls > the
 * built-in mainnet-beta endpoint (rpc.js getPublicFallbackUrls has no Solana
 * entry, so the built-in lives here). PUBLIC_RPC_FALLBACK=off -> none.
 */
export function solanaPublicUrls(chainKey = "solana") {
  if (/^(off|false|0|no)$/i.test(process.env.PUBLIC_RPC_FALLBACK ?? "")) return [];
  const list = getPublicFallbackUrls(chainKey);
  return (list.length ? list : SOLANA_PUBLIC_RPC).map((u) => u.replace(/\/+$/, ""));
}

/** Public endpoints first, then the key pool. Deduplicated, order kept. */
export function solanaRpcCandidates(chainKey = "solana") {
  return [...new Set([...solanaPublicUrls(chainKey), ...getAllRpcUrls(chainKey)])];
}

async function probe(url, call) {
  try {
    const r = await call(url, "getHealth", []);
    if (r === "ok" || r === undefined || r === null) return { url, ok: true };
    return { url, ok: false, reason: String(r) };
  } catch (err) {
    // Some providers do not expose getHealth; getSlot answering is enough.
    try {
      const slot = await call(url, "getSlot", []);
      return Number.isFinite(Number(slot)) ? { url, ok: true } : { url, ok: false, reason: "bad getSlot" };
    } catch (err2) {
      return { url, ok: false, reason: String(err2?.message ?? err?.message ?? err2) };
    }
  }
}

/** One-shot JSON-RPC call (no retry ladder) for the health probe. */
async function probeCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(Number(process.env.RPC_PROBE_TIMEOUT_MS) || 10000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body.result;
}

/**
 * Usable Solana RPC URLs for a chain, in preference order. Throws
 * `RPC pool <key>: no usable endpoint` when none answers.
 */
export async function getUsableSolanaRpcUrls(chainKey = "solana", { logger = console, call = probeCall } = {}) {
  if (usableCache.has(chainKey)) return usableCache.get(chainKey);
  const candidates = solanaRpcCandidates(chainKey);
  if (candidates.length === 0) {
    throw new Error(`RPC pool ${chainKey}: no usable endpoint (no public URL and no ${chainKey.toUpperCase()}_RPC_n key configured)`);
  }
  const results = await Promise.all(candidates.map((u) => probe(u, call)));
  const usable = results.filter((r) => r.ok).map((r) => r.url);
  const dead = results.filter((r) => !r.ok);
  logger.log?.(
    `RPC pool ${chainKey}: ${usable.length}/${candidates.length} usable (public first)` +
      (dead.length ? ` — skipping ${dead.map((d) => `…${d.url.slice(-12)} (${String(d.reason).slice(0, 40)})`).join(", ")}` : ""),
  );
  if (usable.length === 0) {
    throw new Error(`RPC pool ${chainKey}: no usable endpoint (first reason: ${dead[0]?.reason ?? "unknown"})`);
  }
  usableCache.set(chainKey, usable);
  return usable;
}

/**
 * Runs `method` on each URL in turn until one succeeds. Every URL failing
 * throws with all reasons, plus a hint to set SOLANA_RPC_* for heavy calls.
 */
export async function solanaCallWithFailover(urls, method, params, { call = rpcCall, chainKey = "solana", logger = console } = {}) {
  const errors = [];
  for (const url of urls) {
    try {
      return await call(url, method, params);
    } catch (err) {
      const msg = String(err?.message ?? err);
      errors.push(`${url.replace(/\?.*$/, "").slice(0, 48)}: ${msg.slice(0, 160)}`);
      logger.warn?.(`  ${chainKey} ${method} failed on …${url.slice(-12)} (${msg.slice(0, 80)}) — trying next endpoint`);
    }
  }
  const hint =
    method === "getProgramAccounts"
      ? ` Public Solana RPC often refuses getProgramAccounts for large mints; set ${chainKey.toUpperCase()}_RPC_0 (a free-tier key) in .env.enc.`
      : "";
  throw new Error(`${chainKey} ${method}: every RPC endpoint failed.${hint} [${errors.join(" | ")}]`);
}

/** Test hook. */
export function __resetSolanaRpcForTests() {
  usableCache.clear();
}
