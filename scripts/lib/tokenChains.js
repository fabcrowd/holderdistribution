/**
 * Lightweight token chain discovery (advisory, free/public only).
 *
 * Answers "is this project's token also on EVM chains its config doesn't
 * list?" with two keyless methods:
 *
 *   1. Same-address probe: eth_getCode + symbol()/decimals() on each candidate
 *      chain's free public RPC. Catches CREATE2 / multichain deployers that put
 *      the token at one address everywhere.
 *   2. CoinGecko contract lookup (optional, keyless public API, rate-limited):
 *      /coins/<platform>/contract/<address> returns the coin's `platforms`
 *      map, which lists bridged copies at DIFFERENT addresses. Each listed
 *      address is then confirmed on-chain with the same RPC probe.
 *
 * Solana: when CoinGecko's `platforms.solana` lists a mint (or the project
 * itself has a Solana chain), the report adds a Solana row. The base58 mint is
 * kept EXACTLY as listed (never lowercased) and confirmed with the mint's
 * on-chain metadata over the public Solana RPC.
 *
 * Every candidate carries `suggestedBridge: "native"` plus
 * `bridgeNeedsConfirmation: true`: a human picks native / lock-mint /
 * burn-mint in the map-new-token questionnaire (wrapped/bridged design).
 *
 * Never edits config. The report is a review queue for the onboarding
 * questionnaire (docs/MULTI-TOKEN.md "Chain discovery"). No paid APIs, no keys.
 */
import { isEvmAddress, isSolanaAddress } from "./address.js";

/** Candidate EVM chains: key (matches scripts/lib/rpc.js), chainId, explorer, CoinGecko platform id. */
export const CANDIDATE_CHAINS = [
  { key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io", coingecko: "ethereum" },
  { key: "polygon", name: "Polygon", chainId: 137, explorer: "https://polygonscan.com", coingecko: "polygon-pos" },
  { key: "base", name: "Base", chainId: 8453, explorer: "https://basescan.org", coingecko: "base" },
  { key: "arbitrum", name: "Arbitrum One", chainId: 42161, explorer: "https://arbiscan.io", coingecko: "arbitrum-one" },
  { key: "optimism", name: "OP Mainnet", chainId: 10, explorer: "https://optimistic.etherscan.io", coingecko: "optimistic-ethereum" },
  { key: "bsc", name: "BNB Smart Chain", chainId: 56, explorer: "https://bscscan.com", coingecko: "binance-smart-chain" },
  { key: "avalanche", name: "Avalanche C-Chain", chainId: 43114, explorer: "https://snowtrace.io", coingecko: "avalanche" },
];

/** The Solana candidate (non-EVM; probed by mint metadata, not eth_getCode). */
export const SOLANA_CANDIDATE = { key: "solana", name: "Solana", vm: "solana", explorer: "https://solscan.io", coingecko: "solana" };

const SELECTOR = { symbol: "0x95d89b41", decimals: "0x313ce567" };
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Decodes an ABI `string` return, or a bytes32 symbol (old tokens like MKR). */
export function decodeAbiString(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length < 66) return null;
  const body = hex.slice(2);
  const toUtf8 = (h) => Buffer.from(h, "hex").toString("utf8").replace(/\u0000+$/g, "");
  if (body.length === 64) return toUtf8(body) || null; // bytes32
  const offset = parseInt(body.slice(0, 64), 16) * 2;
  const len = parseInt(body.slice(offset, offset + 64), 16);
  if (!Number.isFinite(len) || len > 256) return null;
  return toUtf8(body.slice(offset + 64, offset + 64 + len * 2)) || null;
}

export function decodeUint(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  const n = Number(BigInt(hex));
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Probes one address on one chain. `call(url, method, params)` is a JSON-RPC
 * caller (rpc.js rpcCall in the CLI; a stub in tests). Tries each URL until
 * one answers.
 * @returns {Promise<{status: "found"|"no-code"|"rpc-error", symbol?: string|null, decimals?: number|null, rpc?: string, error?: string}>}
 */
export async function probeToken({ urls, address, call }) {
  let lastError = "no public RPC configured";
  for (const url of urls ?? []) {
    try {
      const code = await call(url, "eth_getCode", [address, "latest"]);
      if (typeof code !== "string" || code === "0x" || code === "0x0") return { status: "no-code", rpc: url };
      const [sym, dec] = await Promise.all([
        call(url, "eth_call", [{ to: address, data: SELECTOR.symbol }, "latest"]).catch(() => null),
        call(url, "eth_call", [{ to: address, data: SELECTOR.decimals }, "latest"]).catch(() => null),
      ]);
      return { status: "found", symbol: decodeAbiString(sym), decimals: decodeUint(dec), rpc: url };
    } catch (err) {
      lastError = String(err?.message ?? err);
    }
  }
  return { status: "rpc-error", error: lastError };
}

/** CoinGecko `platforms` map -> { chainKey: address } for the candidate chains we know. */
export function platformsToChains(platforms, candidates = CANDIDATE_CHAINS) {
  const out = {};
  for (const c of candidates) {
    const a = platforms?.[c.coingecko];
    if (typeof a === "string" && ADDRESS_RE.test(a.trim())) out[c.key] = a.trim().toLowerCase();
  }
  return out;
}

/** CoinGecko `platforms.solana` as a base58 mint, case preserved; null if absent/invalid. */
export function solanaPlatformAddress(platforms) {
  const a = platforms?.[SOLANA_CANDIDATE.coingecko];
  return typeof a === "string" && isSolanaAddress(a.trim()) ? a.trim() : null;
}

/** Keyless CoinGecko lookup. Returns {} on any failure (rate limit, unlisted). */
export async function coingeckoPlatforms({ platform, address, fetchImpl = fetch }) {
  try {
    // Hex is case-insensitive (CoinGecko wants lowercase); base58 is not.
    const id = isEvmAddress(address) ? address.toLowerCase() : address.trim();
    const res = await fetchImpl(
      `https://api.coingecko.com/api/v3/coins/${platform}/contract/${id}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return {};
    const body = await res.json();
    return body?.platforms ?? {};
  } catch {
    return {};
  }
}

/**
 * Builds the discovery report for a project.
 *
 * @param {object} p
 * @param {{ticker: string, chains: Array<{key: string, tokens?: Array<{address: string, decimals?: number, status?: string}>}>}} p.config
 * @param {(url: string, method: string, params: unknown[]) => Promise<unknown>} p.call
 * @param {(chainKey: string) => string[]} p.urlsFor public RPC URLs per chain
 * @param {boolean} [p.useCoingecko]
 * @param {Function} [p.fetchImpl]
 * @param {(mint: string) => Promise<{status: string, symbol?: string|null, decimals?: number, program?: string, error?: string}>} [p.solanaProbe]
 *   confirms a Solana mint (default: none -> "listed-unverified")
 */
export async function detectTokenChains({ config, call, urlsFor, useCoingecko = false, fetchImpl = fetch, candidates = CANDIDATE_CHAINS, solanaProbe = null }) {
  const configured = new Map((config.chains ?? []).map((c) => [c.key, c]));
  const isSolanaChain = (c) => c?.vm === "solana" || (c?.vm === undefined && c?.key === "solana");
  const canonicalOf = (c) => (c.tokens ?? []).find((t) => t.status === "canonical") ?? (c.tokens ?? []).at(-1);
  const originChain = (config.chains ?? []).find((c) => c.origin) ?? config.chains?.[0];
  const origin = originChain ? canonicalOf(originChain) : null;
  // Same-address probes are EVM-only: hex seeds only, lowercased.
  const seedAddresses = [
    ...new Set((config.chains ?? []).map(canonicalOf).filter((t) => isEvmAddress(t?.address)).map((t) => t.address.toLowerCase())),
  ];

  let listed = {};
  let listedSolana = null;
  if (useCoingecko && origin && originChain) {
    const platform = isSolanaChain(originChain)
      ? SOLANA_CANDIDATE.coingecko
      : candidates.find((c) => c.key === originChain.key)?.coingecko;
    // Canonical first, then older generations (CoinGecko may only list one of them).
    const originTokens = [origin, ...(originChain.tokens ?? []).filter((t) => t !== origin)];
    for (const t of platform ? originTokens : []) {
      const platforms = await coingeckoPlatforms({ platform, address: t.address, fetchImpl });
      listed = platformsToChains(platforms, candidates);
      listedSolana = solanaPlatformAddress(platforms);
      if (Object.keys(listed).length || listedSolana) break;
    }
  }
  const bridgeHint = { suggestedBridge: "native", bridgeNeedsConfirmation: true };

  const ticker = String(config.ticker ?? "").toUpperCase();
  const results = [];
  for (const chain of candidates) {
    if (configured.has(chain.key)) {
      results.push({ chain: chain.key, name: chain.name, status: "configured" });
      continue;
    }
    // Addresses to try here: CoinGecko's listing first, then the project's own addresses (same-address deploys).
    const tries = [...new Set([listed[chain.key], ...seedAddresses].filter(Boolean))];
    let best = { chain: chain.key, name: chain.name, status: "not-found" };
    for (const address of tries) {
      const r = await probeToken({ urls: urlsFor(chain.key), address, call });
      if (r.status === "rpc-error") { best = { ...best, status: "rpc-error", error: r.error }; continue; }
      if (r.status !== "found") continue;
      const symbolMatch = !!r.symbol && r.symbol.toUpperCase() === ticker;
      best = {
        chain: chain.key,
        name: chain.name,
        chainId: chain.chainId,
        status: symbolMatch ? "candidate" : "contract-other-symbol",
        address,
        symbol: r.symbol,
        decimals: r.decimals,
        source: listed[chain.key] === address ? "coingecko" : "same-address",
        explorer: `${chain.explorer}/token/${address}`,
        ...bridgeHint,
      };
      if (symbolMatch) break;
    }
    results.push(best);
  }

  // Solana row: only when the project has a Solana chain or CoinGecko lists one.
  const configuredSolana = (config.chains ?? []).find(isSolanaChain);
  if (configuredSolana) {
    results.push({ chain: configuredSolana.key, name: SOLANA_CANDIDATE.name, vm: "solana", status: "configured" });
  } else if (listedSolana) {
    const row = {
      chain: SOLANA_CANDIDATE.key,
      name: SOLANA_CANDIDATE.name,
      vm: "solana",
      address: listedSolana, // base58, case preserved
      source: "coingecko",
      explorer: `${SOLANA_CANDIDATE.explorer}/token/${listedSolana}`,
      ...bridgeHint,
    };
    if (!solanaProbe) {
      results.push({ ...row, status: "listed-unverified" });
    } else {
      const r = await solanaProbe(listedSolana).catch((error) => ({ status: "rpc-error", error: error.message }));
      if (r.status === "found") {
        const symbolMatch = !!r.symbol && r.symbol.toUpperCase() === ticker;
        results.push({
          ...row,
          status: symbolMatch || !r.symbol ? "candidate" : "contract-other-symbol",
          symbol: r.symbol ?? null,
          decimals: r.decimals,
          ...(r.program ? { program: r.program } : {}),
        });
      } else {
        results.push({ ...row, status: r.status ?? "not-found", ...(r.error ? { error: r.error } : {}) });
      }
    }
  }
  return {
    ticker,
    checkedAt: new Date().toISOString(),
    methods: useCoingecko ? ["same-address-rpc", "coingecko-platforms"] : ["same-address-rpc"],
    candidates: results.filter((r) => r.status === "candidate"),
    chains: results,
  };
}
