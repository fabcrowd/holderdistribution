/**
 * Solana chain adapter (vm: "solana"). Loaded ONLY through
 * chainAdapters.loadChainAdapter("solana"), i.e. only for a project that lists
 * a Solana chain. Same interface as the EVM adapter; scanChain() is the
 * pipeline entry point used by pull-holders-rpc.js and returns the same
 * per-chain pieces the EVM log scan returns (balance map, token totals,
 * checkpoint entry), so the shared feed writers produce views.<key> /
 * chains.<key> unchanged.
 */
import { chainExplorerUrl } from "../chainAdapters.js";
import { normalizeAddressForVm } from "../address.js";
import { fetchMintMetadata, PROGRAM_BY_NAME } from "./metadata.js";
import { getUsableSolanaRpcUrls, solanaCallWithFailover, configureSolanaChain } from "./rpc.js";
import { scanMintHolders } from "./splScanner.js";

const MIN_RAW = 1n; // any positive balance, same as EVM MIN_TEL_RAW

/** The chain's scanned (base) token: legacy slot / canonical / only token. */
export function solanaBaseToken(chain) {
  if (chain?.tokens && !Array.isArray(chain.tokens)) return chain.tokens.legacy ?? null; // derived chain map
  const tokens = chain?.tokens ?? [];
  return tokens.find((t) => t.generation === "legacy") ?? tokens.find((t) => t.status === "canonical") ?? tokens[0] ?? null;
}

function boundCaller(urls, chainKey, logger, rawCall) {
  return (method, params) => solanaCallWithFailover(urls, method, params, { chainKey, logger, ...(rawCall ? { call: rawCall } : {}) });
}

export const solanaAdapter = {
  vm: "solana",

  async health(chain, { logger = console, probeCall } = {}) {
    configureSolanaChain(chain);
    return getUsableSolanaRpcUrls(chain.key, { logger, ...(probeCall ? { call: probeCall } : {}) });
  },

  normalizeAddress: (_chain, address) => normalizeAddressForVm("solana", address),

  explorerUrl: (chain, kind, id) => chainExplorerUrl({ ...chain, vm: "solana" }, kind, id),

  async tokenMeta(chain, token, { urls, logger = console, call: rawCall, fallbackSymbol = null } = {}) {
    const pool = urls ?? (await this.health(chain, { logger }));
    const call = boundCaller(pool, chain.key, logger, rawCall);
    const meta = await fetchMintMetadata(call, token.address, { fallbackSymbol: token.symbol ?? fallbackSymbol });
    if (token.program && PROGRAM_BY_NAME[token.program] !== meta.programId) {
      throw new Error(`solana ${token.address}: config says program ${token.program} but the mint is owned by ${meta.program}`);
    }
    if (token.decimals !== undefined && Number(token.decimals) !== meta.decimals) {
      throw new Error(`solana ${token.address}: config decimals ${token.decimals} != mint decimals ${meta.decimals}`);
    }
    return meta;
  },

  async scanHolders(chain, token, { urls, logger = console, call: rawCall, meta } = {}) {
    const pool = urls ?? (await this.health(chain, { logger }));
    const call = boundCaller(pool, chain.key, logger, rawCall);
    const m = meta ?? (await this.tokenMeta(chain, token, { urls: pool, logger, call: rawCall }));
    const scan = await scanMintHolders(call, {
      mint: token.address,
      programId: m.programId,
      program: m.program,
      decimals: m.decimals,
      supplyRaw: m.supplyRaw,
      logger,
    });
    return { ...scan, meta: m };
  },

  /**
   * Pipeline entry: snapshot one Solana chain. Returns
   *   balances        Map<owner, human balance> (owners as written)
   *   tokenTotals     { legacy: mint supply, v3: 0, retiredLegacy: 0, strandedInUpgrade: 0 }
   *   checkpointData  { vm, lastBlock: slot, lastSlot, mint, holders, scannedAt }
   *   tokenAccountOwners Map<token account, owner> (to classify contracts{} that list token accounts)
   */
  async scanChain(chain, { logger = console, call: rawCall, probeCall, now = () => new Date() } = {}) {
    const token = solanaBaseToken(chain);
    if (!token?.address) throw new Error(`solana chain ${chain?.key}: no token mint configured`);
    const urls = await this.health(chain, { logger, probeCall });
    logger.log?.(`  ${chain.key}: ${urls.length} Solana RPC URL(s), public first.`);
    const scan = await this.scanHolders(chain, token, { urls, logger, call: rawCall });
    const balances = new Map();
    for (const h of scan.holders) {
      if (BigInt(h.raw) < MIN_RAW) continue;
      balances.set(h.address, h.balance);
    }
    logger.log?.(
      `  ${chain.key}: ${balances.size} holders (${scan.accounts} token accounts, ${scan.zeroAccounts} empty) ` +
        `for ${scan.meta.symbol ?? token.address} [${scan.meta.program}]` + (scan.slot ? ` at slot ${scan.slot}` : ""),
    );
    return {
      chainKey: chain.key,
      balances,
      tokenTotals: { legacy: scan.meta.supply, v3: 0, retiredLegacy: 0, strandedInUpgrade: 0 },
      checkpointData: {
        vm: "solana",
        ...(scan.slot ? { lastBlock: scan.slot, lastSlot: scan.slot } : {}),
        mint: token.address,
        program: scan.meta.program,
        decimals: scan.meta.decimals,
        holders: balances.size,
        scannedAt: now().toISOString(),
      },
      tokenAccountOwners: scan.tokenAccountOwners,
      meta: scan.meta,
    };
  },
};
