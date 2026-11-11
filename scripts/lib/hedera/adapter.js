/**
 * Hedera chain adapter (vm: "hedera"). Loaded ONLY through
 * chainAdapters.loadChainAdapter("hedera"). Native-coin (HBAR) holders from the
 * public mirror node; no key. scanChain() returns the same pieces as the
 * Solana adapter (balances Map, tokenTotals, checkpointData, tokenAccountOwners).
 *
 * Holder rule (owner decision 2026-11-08): at least 1 HBAR, contracts excluded,
 * HTS-only accounts (0 HBAR) excluded. The /balances rows do not say whether an
 * id is an account or a contract, so contracts come from a separate full pass of
 * /contracts (about 1k pages, against about 40k for the balance scan).
 */
import { chainExplorerUrl } from "../chainAdapters.js";
import { parseHederaAddress } from "./address.js";
import { createHederaClock } from "./clock.js";
import { createMirrorClient, HEDERA_MAINNET_MIRROR } from "./mirror.js";
import { HEDERA_RANGE_WIDTH, resumeProblem, scanBalanceSnapshot, scanContractIds } from "./scan.js";

export const HEDERA_DECIMALS = 8;
const TINYBAR_PER_HBAR = 100_000_000n;
export const HEDERA_HOLDER_FLOOR_TINYBAR = TINYBAR_PER_HBAR; // 1 HBAR
const HASHSCAN = Object.freeze({
  token: "https://hashscan.io/mainnet/token/{address}",
  address: "https://hashscan.io/mainnet/account/{address}",
  tx: "https://hashscan.io/mainnet/transaction/{tx}",
});

/** Tinybars (BigInt) to a human HBAR number without passing through a lossy 2^53 intermediate. */
export const tinybarToHbar = (raw) => Number(raw / TINYBAR_PER_HBAR) + Number(raw % TINYBAR_PER_HBAR) / 1e8;

const CLIENT_KEYS = { fetch: "fetch", sleep: "sleep", nowMs: "now", maxRps: "maxRps", maxAttempts: "maxAttempts", random: "random" };

function clientFor(chain, opts = {}) {
  if (opts.client) return opts.client;
  const baseUrl = chain?.mirrorUrl ?? process.env.HEDERA_MIRROR_URL ?? HEDERA_MAINNET_MIRROR;
  const overrides = Object.fromEntries(Object.entries(CLIENT_KEYS).filter(([k]) => opts[k] !== undefined).map(([k, to]) => [to, opts[k]]));
  return createMirrorClient({ baseUrl, ...overrides });
}

const floorOf = (chain) => BigInt(chain?.holderFloorTinybar ?? HEDERA_HOLDER_FLOOR_TINYBAR);

export const hederaAdapter = {
  vm: "hedera",

  async health(chain, opts = {}) {
    const client = clientFor(chain, opts);
    await client.getJson("/network/supply");
    return [client.baseUrl];
  },

  normalizeAddress: (_chain, address) => parseHederaAddress(address),

  isAddress: (_chain, address) => parseHederaAddress(address) !== null,

  clock: (chain, opts = {}) => createHederaClock(clientFor(chain, opts)),

  explorerUrl(chain, kind, id) {
    const key = kind === "tx" ? id : (parseHederaAddress(id) ?? id);
    return chainExplorerUrl({ ...chain, vm: "hedera", explorerTemplates: { ...HASHSCAN, ...chain?.explorerTemplates } }, kind, key);
  },

  /** Native coin: the token argument is ignored. Supply is exact tinybars plus a human number. */
  async tokenMeta(chain, _token, opts = {}) {
    const supply = await clientFor(chain, opts).getJson("/network/supply");
    const supplyRaw = BigInt(supply.total_supply);
    const releasedSupplyRaw = BigInt(supply.released_supply);
    return {
      symbol: "HBAR",
      name: "HBAR",
      decimals: HEDERA_DECIMALS,
      supplyRaw,
      releasedSupplyRaw,
      supply: tinybarToHbar(supplyRaw),
      releasedSupply: tinybarToHbar(releasedSupplyRaw),
      supplyTimestamp: supply.timestamp,
    };
  },

  /** Why a saved scan state cannot be resumed for this chain config (other floor or range width), or null when it can. */
  resumeProblem: (chain, resume) =>
    resumeProblem(resume, { floor: floorOf(chain), width: chain?.rangeWidth ?? HEDERA_RANGE_WIDTH }),

  async scanHolders(chain, _token, opts = {}) {
    const scan = await this.scanChain(chain, opts);
    return { holders: [...scan.balances].map(([address, balance]) => ({ address, balance })), meta: scan.meta, scan };
  },

  /**
   * Snapshot HBAR holders. Pages /balances at one explicit timestamp, then drops
   * contracts. Rejects (never partial) when any page fails after retries.
   * opts: { logger, resume, onProgress, now (Date factory), client | fetch/sleep/nowMs/maxAttempts/... }.
   */
  async scanChain(chain, opts = {}) {
    const { logger = console, resume = null, onProgress = null, now = () => new Date() } = opts;
    const client = clientFor(chain, opts);
    const floor = floorOf(chain);
    const width = chain?.rangeWidth ?? HEDERA_RANGE_WIDTH;
    const meta = await this.tokenMeta(chain, null, { client });
    const snapshot = await scanBalanceSnapshot(client, { floor, width, resume, onProgress, ...(opts.nowMs ? { nowMs: opts.nowMs } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}), ...(opts.random ? { random: opts.random } : {}), ...(opts.snapshotWaitMs !== undefined ? { snapshotWaitMs: opts.snapshotWaitMs } : {}) });
    // HBAR is never burned, so every balance at one snapshot, contracts and dust included, adds up to total supply.
    // A shortfall means a range lost rows; refusing it keeps a short count out of the feeds.
    const supplyAt = await client.getJson(`/network/supply?timestamp=${snapshot.timestamp}`);
    const supplyAtRaw = BigInt(supplyAt.total_supply);
    if (snapshot.allRaw !== supplyAtRaw) {
      throw new Error(`hedera snapshot ${snapshot.timestamp}: balances sum to ${snapshot.allRaw} tinybar, total supply is ${supplyAtRaw}`);
    }
    const contractIds = await scanContractIds(client, { maxId: snapshot.maxId, width });
    const block = await createHederaClock(client).blockAtOrBefore(snapshot.timestamp);

    const balances = new Map();
    let heldRaw = 0n;
    let contractsExcluded = 0;
    for (const [num, text] of snapshot.rows) {
      const raw = BigInt(text);
      if (raw < floor) continue;
      if (contractIds.has(num)) {
        contractsExcluded += 1;
        continue;
      }
      balances.set(`0.0.${num}`, tinybarToHbar(raw));
      heldRaw += raw;
    }
    logger.log?.(
      `  ${chain.key}: ${balances.size} holders >= ${tinybarToHbar(floor)} HBAR, ${contractsExcluded} contracts excluded ` +
        `(${contractIds.size} contracts listed) at snapshot ${snapshot.timestamp}`,
    );
    return {
      chainKey: chain.key,
      balances,
      tokenTotals: { legacy: meta.supply, v3: 0, retiredLegacy: 0, strandedInUpgrade: 0 },
      checkpointData: {
        vm: "hedera",
        ...(block ? { lastBlock: block.number } : {}),
        snapshotTimestamp: snapshot.timestamp,
        floorTinybar: floor.toString(),
        decimals: HEDERA_DECIMALS,
        holders: balances.size,
        snapshotClusterId: snapshot.clusterId,
        snapshotMismatchRetries: snapshot.mismatchRetries,
        snapshotWaitByCluster: snapshot.waitByCluster,
        contractsExcluded,
        heldRawTotal: heldRaw.toString(),
        snapshotRawTotal: snapshot.allRaw.toString(),
        nonzeroAccounts: snapshot.nonzero,
        supplyRaw: meta.supplyRaw.toString(),
        releasedAtSnapshotRaw: String(supplyAt.released_supply),
        // snapshotAt is the pinned mirror stamp. scannedAt is when this run finished reading it.
        snapshotAt: new Date(Number(snapshot.timestamp.split(".")[0]) * 1000).toISOString(),
        scannedAt: now().toISOString(),
      },
      tokenAccountOwners: new Map(),
      meta,
    };
  },
};
