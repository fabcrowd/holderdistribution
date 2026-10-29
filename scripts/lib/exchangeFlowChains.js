/**
 * Per-chain scan settings for scripts/scan-exchange-flows.js, resolved from a
 * project's chain map (scripts/lib/projects.js projectChains()).
 *
 * TEL (legacyRoot) keeps its tuned defaults byte-for-byte: ~1 year back on
 * Ethereum/Polygon and TEL's first Base Transfer (25_614_028, verified via
 * Blockscout getLogs from block 0), with the same env overrides as before.
 * Any other project starts at each chain's `fromBlock` (or the token's
 * deployBlock) and can override with FLOW_START_BLOCK_<CHAINKEY>.
 */

// Ethereum: 800-block chunks; Polygon/Base: 1000 (public endpoints' getLogs caps).
const CHUNK = { ethereum: 800, polygon: 1000, base: 1000 };

// Tuned first-scan blocks for legacyRoot (TEL) chains, keyed by chain key.
const LEGACY_START_DEFAULT = { ethereum: 22_800_000, polygon: 74_400_000, base: 25_614_028 };

const tokenFor = (chainMap, chainKey) => {
  const token = chainMap[chainKey]?.tokenAddress;
  if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/i.test(token)) {
    throw new Error(`chain map is missing a valid tokenAddress for ${chainKey}`);
  }
  return token.toLowerCase();
};

const divisorFor = (chainMap, chainKey) => {
  const d = Number(chainMap[chainKey]?.decimals ?? chainMap[chainKey]?.tokens?.legacy?.decimals);
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error(`chain map has no valid decimals for ${chainKey}`);
  return 10 ** d;
};

/** @returns {Record<string, {token:string, chunk:number, defaultStart:number, divisor:number}>} */
export function exchangeFlowChains(project, chainMap, env = process.env) {
  const legacy = project.config?.data?.legacyRoot === true;
  const out = {};
  for (const chainKey of Object.keys(chainMap)) {
    const meta = chainMap[chainKey];
    // Legacy TEL kept FLOW_START_BLOCK_ETH for Ethereum; both spellings work.
    const envStart = env[`FLOW_START_BLOCK_${chainKey.toUpperCase()}`] ?? (chainKey === "ethereum" ? env.FLOW_START_BLOCK_ETH : undefined);
    out[chainKey] = {
      token: tokenFor(chainMap, chainKey),
      chunk: Number(env[`FLOW_CHUNK_${chainKey.toUpperCase()}`] ?? CHUNK[chainKey] ?? 1000),
      defaultStart: Number(envStart ?? (legacy ? LEGACY_START_DEFAULT[chainKey] : undefined) ?? meta.fromBlock ?? meta.tokens?.legacy?.deployBlock ?? 0),
      divisor: divisorFor(chainMap, chainKey),
    };
  }
  return out;
}


