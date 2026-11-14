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
import { settleRows } from "./settle.js";

/** True when mirror stamp `a` is later than `b` ("seconds.nanos" strings). */
const stampAfter = (a, b) => {
  const n = (s) => {
    const [sec, frac = ""] = String(s).split(".");
    return BigInt(sec) * 1_000_000_000n + BigInt(frac.padEnd(9, "0").slice(0, 9));
  };
  return n(a) > n(b);
};

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

  /** The rate-limited mirror client the other methods use (one limiter per client: share it across a run). */
  mirrorClient: (chain, opts = {}) => clientFor(chain, opts),

  /** Exchange-flow scan, classification and config helpers (lib/hedera/flows.js), loaded on demand. */
  flows: () => import("./flows.js"),

  /** Wallet-flow scan, registry and ledger helpers for the project-controlled treasury accounts (lib/hedera/walletFlows.js), loaded on demand. */
  walletFlows: () => import("./walletFlows.js"),

  /** Network-wide staked HBAR (informational), lib/hedera/networkStake.js, loaded on demand. Never throws. */
  stakingInfo: async (chain, opts = {}) => (await import("./networkStake.js")).fetchNetworkStake(chain, opts),

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

  /**
   * Classification a project on this chain's native coin starts with (onboard.js writes it):
   * network treasury exclusions, chain contracts{} roles, the treasury categories they fill, and
   * job limits that fit one full /balances scan until daily replay replaces it. Two measurements: 93 min
   * locally, 67 min in the newer end-to-end run; the step cap takes the slower one plus headroom.
   */
  async nativeClassification() {
    const { hederaChainContracts, hederaTreasuryExclusions } = await import("./treasury.js");
    const { hederaCexWallets } = await import("./cexAccounts.js");
    const { HEDERA_CIRCULATING_SUBTRACT, hederaNightlyWaivers } = await import("./nativeDecisions.js");
    return {
      exclusions: hederaTreasuryExclusions(),
      contracts: hederaChainContracts(),
      cexWallets: hederaCexWallets(),
      treasuryCategories: ["treasury"],
      circulatingSubtract: [...HEDERA_CIRCULATING_SUBTRACT],
      nightlyWaivers: hederaNightlyWaivers(),
      // Job budget (refresh-holders.yml, minutes): setup ~3 + holders scan 120 + retry 35 + generators ~10 +
      // Hedera flows 45 + exchange flows 25 + tier outflows 25 = 263, under 270 (GitHub's job limit is 360).
      // The sum assumes the staker-balance step (20 min cap) and the Solana staking step (10 min cap) exit at once for Hedera, and that the Solana flows and EVM gap-fill steps are skipped; steps without a cap (CEX wallet sync, history, reconcile, commits) are not in the sum.
      workflowTimeoutMinutes: 270,
      holdersScanTimeoutMinutes: 120, // scan measured 67 min (end to end) and 93 min (local): one step must finish it
    };
  },

  /** The owner decisions the onboarding runner reads for this coin (history mode, acknowledged large holders), in the answers-file shape. */
  async nativeDecisions() {
    return (await import("./nativeDecisions.js")).hederaNativeDecisions();
  },

  /** Why a saved scan state cannot be resumed for this chain config (other floor or range width), or null when it can. */
  resumeProblem: (chain, resume) =>
    resumeProblem(resume, { floor: floorOf(chain), width: chain?.rangeWidth ?? HEDERA_RANGE_WIDTH }),

  /** Opt-in: a finished scan state may stay on disk after the checkpoint is saved; scanChain serves it only for the same resolved stamp. */
  keepsFinishedScan: true,

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
    const { logger = console, onProgress = null, now = () => new Date(), pinBlock = null } = opts;
    let { resume = null } = opts;
    const client = clientFor(chain, opts);
    const floor = floorOf(chain);
    const width = chain?.rangeWidth ?? HEDERA_RANGE_WIDTH;
    const meta = await this.tokenMeta(chain, null, { client });
    const waitOpts = { ...(opts.nowMs ? { nowMs: opts.nowMs } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}), ...(opts.random ? { random: opts.random } : {}), ...(opts.snapshotWaitMs !== undefined ? { snapshotWaitMs: opts.snapshotWaitMs } : {}) };
    // pinBlock (the settled day's cutoff - 1): read the state at the end of that block. The baseline is the newest
    // snapshot at or before the block's last consensus time; settleRows replays the transactions after it.
    const settle = pinBlock != null ? await createHederaClock(client).rangeOf(pinBlock) : null;
    if (settle && resume && stampAfter(resume.timestamp, settle.to)) {
      logger.warn?.(`  ${chain.key}: saved scan state at ${resume.timestamp} is after block ${pinBlock} (ends ${settle.to}); starting a fresh scan.`);
      resume = null;
    }
    // scanBalanceSnapshot drops an in-progress state that is too far from the snapshot a fresh run would use, and says so
    // through onResumeDropped before it starts paging.
    const onResumeDropped = (reason, { savedStamp }) => logger.warn?.(`  ${chain.key}: saved in-progress scan state at ${savedStamp} is ${reason}; starting a fresh scan.`);
    const scan = (from) => scanBalanceSnapshot(client, { floor, width, resume: from, onProgress, onResumeDropped, atOrBefore: settle?.to ?? null, ...waitOpts });
    let snapshot = await scan(resume);
    if (snapshot.finishedState === "reused") logger.log?.(`  ${chain.key}: reusing the finished scan of snapshot ${snapshot.timestamp} (no balance paging).`);
    else if (snapshot.finishedState === "discarded") logger.log?.(`  ${chain.key}: the saved finished scan is for another snapshot than ${snapshot.timestamp}; scanned afresh.`);
    // HBAR is never burned, so every balance at one snapshot, contracts and dust included, adds up to total supply.
    // A shortfall means a range lost rows; refusing it keeps a short count out of the feeds.
    let supplyAt = await client.getJson(`/network/supply?timestamp=${snapshot.timestamp}`);
    if (snapshot.finishedState === "reused" && snapshot.allRaw !== BigInt(supplyAt.total_supply)) {
      // A saved finished state that fails the check is not trusted again: scan the same stamp afresh.
      logger.warn?.(`  ${chain.key}: the reused scan of ${snapshot.timestamp} does not add up to total supply; scanning afresh.`);
      snapshot = await scan(null);
      supplyAt = await client.getJson(`/network/supply?timestamp=${snapshot.timestamp}`);
    }
    const supplyAtRaw = BigInt(supplyAt.total_supply);
    if (snapshot.allRaw !== supplyAtRaw) {
      throw new Error(`hedera snapshot ${snapshot.timestamp}: balances sum to ${snapshot.allRaw} tinybar, total supply is ${supplyAtRaw}`);
    }
    const settled = settle
      ? await settleRows(client, { rows: snapshot.rows, stamp: snapshot.timestamp, cluster: snapshot.clusterId, through: settle.to, floor, ...waitOpts })
      : null;
    const rowsAtEnd = settled ? settled.rows : snapshot.rows;
    // A contract created inside the settle window has an id above the snapshot's highest.
    const contractIds = await scanContractIds(client, { maxId: Math.max(snapshot.maxId, settled?.maxTouched ?? 0), width });
    const block = settle ? { number: settle.number } : await createHederaClock(client).blockAtOrBefore(snapshot.timestamp);
    if (settled) {
      logger.log?.(
        `  ${chain.key}: settled snapshot ${snapshot.timestamp} to the end of block ${settle.number} (${settle.to}): ` +
          `${settled.transactions} transactions (${settled.failedTransactions} failed, fees applied), ${settled.touched} accounts, ${settled.lookups} single-account reads`,
      );
    }

    // A contract with a configured role (WHBAR as dex) stays in the snapshot as a non-retail row, so its HBAR
    // lands in its supply bucket instead of the supply gap; every other contract is dropped.
    const roleIds = new Set(Object.values(chain?.contracts ?? {}).map((c) => parseHederaAddress(c?.address)).filter(Boolean));
    const balances = new Map();
    let heldRaw = 0n;
    let contractsExcluded = 0;
    let roleContractsKept = 0;
    for (const [num, text] of rowsAtEnd) {
      const raw = BigInt(text);
      if (raw < floor) continue;
      if (contractIds.has(num)) {
        if (!roleIds.has(`0.0.${num}`)) {
          contractsExcluded += 1;
          continue;
        }
        roleContractsKept += 1;
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
        ...(settled
          ? { settledThrough: settle.to, settledBlock: settle.number, settleTransactions: settled.transactions, settleFailedTransactions: settled.failedTransactions, settleLookups: settled.lookups }
          : {}),
        floorTinybar: floor.toString(),
        decimals: HEDERA_DECIMALS,
        holders: balances.size,
        snapshotClusterId: snapshot.clusterId,
        snapshotMismatchRetries: snapshot.mismatchRetries,
        snapshotWaitByCluster: snapshot.waitByCluster,
        contractsExcluded,
        roleContractsKept,
        heldRawTotal: heldRaw.toString(),
        // HBAR outside every row: unlabelled contracts plus accounts under the holder floor.
        unlistedRawTotal: (snapshot.allRaw - heldRaw).toString(),
        snapshotRawTotal: snapshot.allRaw.toString(),
        nonzeroAccounts: snapshot.nonzero,
        supplyRaw: meta.supplyRaw.toString(),
        releasedAtSnapshotRaw: String(supplyAt.released_supply),
        // snapshotAt is the moment the balances describe: the settled block's end, else the pinned mirror stamp.
        // scannedAt is when this run finished reading it.
        snapshotAt: new Date(Number((settle?.to ?? snapshot.timestamp).split(".")[0]) * 1000).toISOString(),
        scannedAt: now().toISOString(),
      },
      tokenAccountOwners: new Map(),
      meta,
    };
  },
};
