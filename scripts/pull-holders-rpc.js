#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { keccak256 } from "ethereum-cryptography/keccak";
import { utf8ToBytes } from "ethereum-cryptography/utils";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, rpcCall, getLogs } from "./lib/rpc.js";
import { createLogsFailover } from "./lib/logsFailover.js";
import { residualCustodyBalance } from "./lib/stakingCustody.js";
import { ensureWindowCache, readCommittedJson, replayChainRawBalances } from "./lib/holdersAsOfReplay.js";
import { computeSupplyTotals } from "./lib/supply.js";
import { resolveChainTokens, combineChainBalances, v3StateToCheckpoint } from "./lib/telTokens.js";
import { scanV3Chain } from "./lib/v3Scan.js";
import { loadCexAddressSet, loadDexAddressSet, normalizeAddress as normalizeNonRetailAddress } from "./lib/nonRetailSet.js";
import {
  RETAIL_THRESHOLD,
  MEGA_HOLDER_THRESHOLD,
  createEmptyMetrics,
  computeChainMetrics,
  buildSummary,
} from "./lib/holderMetrics.js";

await loadEnv();

const OUTPUT_PATH = path.resolve(process.cwd(), "public/data/tel-holders.json");
const PREVIOUS_SNAPSHOT_PATH = path.resolve(process.cwd(), "public/data/tel-holders-previous.json");
const SUMMARY_PATH = path.resolve(process.cwd(), "public/data/holders-summary.json");
// Checkpoint persists raw BigInt balances + last scanned block per chain so
// subsequent runs only scan new blocks instead of replaying all history.
const CHECKPOINT_PATH = path.resolve(process.cwd(), "public/data/holders-checkpoint.json");

// --as-of=YYYY-MM-DD rebuilds a PAST day's snapshot instead of scanning live,
// so gaps in holders-history.json can be filled with rows measured exactly the
// way every other row was. Balances come from an anchor checkpoint plus the
// cached Transfer logs (see lib/holdersAsOfReplay.js); everything downstream of
// the scan — staker attribution, exclusions, metrics, both file writes — is the
// pipeline's own, untouched, so the reconstructed row is not a parallel
// definition of the metrics.
const ARG_AS_OF = readArg("--as-of");
const ARG_ANCHOR_DATE = readArg("--anchor-date") ?? "2026-08-21";
const AS_OF_BLOCKS_PATH = path.resolve(process.cwd(), "data/holders-asof-blocks.json");

// Total supply is DERIVED from the origin chain (see scripts/lib/supply.js),
// never hardcoded. The previous hardcoded constant here was 92_577_234_366 —
// uncited, never re-verified, and ~7.4B below both CoinGecko's reported total
// supply (100B) and our own Ethereum-chain sum, which made every "% of supply"
// figure on the site too large.

const MIN_TEL_RAW = 1; // any positive TEL balance — matches CMC/Etherscan methodology

// Staking contract on Polygon. Its balance is excluded, then re-attributed to
// individual stakers from funding-wallets.json; the sum of those attributions is
// checked against this contract's real balance so we can't credit holders with
// TEL that isn't there.
const STAKING_CONTRACT_ADDRESS = "0x92e43aec69207755cb1e6a8dc589aae630476330";
const STAKING_TOLERANCE = 0.01; // 1%

// Alchemy PAYG: Polygon max 2000 blocks per eth_getLogs; ETH/Base unlimited.
const CHAIN_RPC_SETTINGS = {
  ethereum: { defaultChunkSize: 10_000, envChunkKey: "ETH_GETLOGS_CHUNK_SIZE" },
  polygon: { defaultChunkSize: 2_000, envChunkKey: "MATIC_GETLOGS_CHUNK_SIZE" },
  base: { defaultChunkSize: 10_000, envChunkKey: "BASE_GETLOGS_CHUNK_SIZE" },
};

const DEFAULT_FROM_BLOCK = {
  ethereum: 4_600_000,
  polygon: 21_500_000,
  base: 100_000,
};

function readArg(flag) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

function getTransferTopic0() {
  const sig = "Transfer(address,address,uint256)";
  const hash = keccak256(utf8ToBytes(sig));
  return "0x" + Buffer.from(hash).toString("hex");
}

function normalizeAddress(value) {
  return normalizeNonRetailAddress(value);
}

function parseTransferLog(log) {
  const topics = log.topics ?? [];
  const data = (log.data ?? "").replace("0x", "");
  if (topics.length < 3 || data.length < 64) return null;
  const from = "0x" + (topics[1] ?? "").slice(-40).toLowerCase();
  const to = "0x" + (topics[2] ?? "").slice(-40).toLowerCase();
  const value = BigInt("0x" + data.slice(0, 64));
  if (!/^0x[a-f0-9]{40}$/.test(from) || !/^0x[a-f0-9]{40}$/.test(to)) return null;
  return { from, to, value };
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Tries the chunk's assigned URL first, then every other URL in the pool. A
 * pool of keyless public endpoints (the fallback when all Alchemy keys are
 * dead) has members that each reject things differently or go down mid-run, so
 * one endpoint's failure must not fail a chunk another could serve. With a
 * single URL this is exactly the old behaviour.
 */
const getLogsWithFailover = createLogsFailover(getLogs);

/**
 * Streams Transfer logs chunk by chunk, calling onBatch for each chunk so
 * raw log objects are never accumulated in memory. Each batch is processed
 * and discarded before the next chunk is fetched.
 *
 * When multiple RPC URLs are provided, chunks are fetched in parallel
 * (one chunk per URL) to reduce wall-clock time proportionally to the
 * number of available keys. Balance accounting is order-independent
 * (all operations are commutative additions/subtractions) so out-of-order
 * batch delivery is safe.
 *
 * @param {string[]} rpcUrls - One or more RPC endpoint URLs for this chain.
 */
async function streamTransferLogs(rpcUrls, tokenAddress, topic0, fromBlock, chunkSize, onBatch, toBlock = null) {
  // `toBlock` lets the caller pin both tokens (legacy + v3) to ONE head block,
  // so a swap's two legs can never straddle the scan boundary.
  const latest = Number.isFinite(toBlock)
    ? toBlock
    : Number.parseInt(String(await rpcCall(rpcUrls[0], "eth_blockNumber", [])), 16);
  let totalLogs = 0;

  // Pre-build the full list of block ranges so we can slice them into parallel batches.
  const chunks = [];
  for (let from = fromBlock; from <= latest; from += chunkSize) {
    chunks.push({ from, to: Math.min(from + chunkSize - 1, latest) });
  }

  const concurrency = rpcUrls.length; // one chunk per available key
  for (let i = 0; i < chunks.length; i += concurrency) {
    const slice = chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map(({ from, to }, idx) =>
        getLogsWithFailover(rpcUrls, idx % concurrency, {
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          address: tokenAddress.toLowerCase(),
          topics: [topic0],
        }).then((logs) => ({ from, to, logs }))
      )
    );
    for (const { from, to, logs } of results) {
      if (logs.length > 0) {
        onBatch(logs);
        totalLogs += logs.length;
        console.log(`  Logs ${from}-${to}: ${logs.length} (total so far: ${totalLogs})`);
      }
    }
  }

  return { totalLogs, latestBlock: latest };
}

/**
 * Loads the checkpoint file. Returns null if none exists yet.
 * Checkpoint schema: { schemaVersion, generatedAt, chains: { [chainKey]: { lastBlock, rawBalances: { addr: "bigintStr" } } } }
 */
async function loadCheckpoint() {
  try {
    const text = await fs.readFile(CHECKPOINT_PATH, "utf8");
    const cp = JSON.parse(text);
    if (cp?.schemaVersion !== 1) return null;
    return cp;
  } catch {
    return null;
  }
}

async function saveCheckpoint(chainCheckpoints) {
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    chains: chainCheckpoints,
  };
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
  await fs.writeFile(CHECKPOINT_PATH, `${JSON.stringify(payload)}\n`, "utf8");
}

/**
 * @param {number} decimals
 * @param {Record<string,string>} [initialRaw] - address -> BigInt-as-string from checkpoint
 */
function buildBalanceMap(decimals, initialRaw = {}) {
  // Seed from checkpoint (BigInt stored as strings to survive JSON serialisation)
  const raw = new Map(
    Object.entries(initialRaw).map(([addr, val]) => [addr, BigInt(val)])
  );
  return {
    onBatch(batch) {
      for (const log of batch) {
        const p = parseTransferLog(log);
        if (!p) continue;
        if (p.to !== ZERO) raw.set(p.to, (raw.get(p.to) ?? 0n) + p.value);
        if (p.from !== ZERO) raw.set(p.from, (raw.get(p.from) ?? 0n) - p.value);
      }
    },
    /**
     * Returns serialisable raw state for checkpoint.
     * Only saves addresses above the dust threshold (>= MIN_TEL_RAW) so the
     * checkpoint file doesn't accumulate millions of sub-1-TEL addresses.
     */
    getRawState() {
      const out = {};
      const minRaw = BigInt(MIN_TEL_RAW);
      for (const [addr, balance] of raw.entries()) {
        if (balance >= minRaw) out[addr] = balance.toString();
      }
      return out;
    },
    /** Exact raw balances (BigInt), for combining with the v3 token. */
    rawBalances() {
      return raw;
    },
    finalize() {
      const out = new Map();
      for (const [addr, balance] of raw.entries()) {
        if (balance <= 0n || balance < BigInt(MIN_TEL_RAW)) continue;
        const human = Number(balance) / Math.pow(10, decimals);
        if (human > 0) out.set(addr, human);
      }
      raw.clear(); // free raw map memory
      return out;
    },
  };
}

const readJson = async (absolutePath) => {
  const content = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(content);
};

const loadChainConfig = async () => readJson(path.resolve(process.cwd(), "config/chains.json"));
const loadExclusions = async () => readJson(path.resolve(process.cwd(), "config/exclusions.json"));

const loadFundingWallets = async () => {
  try {
    // In --as-of mode use the staking snapshot committed on or before the
    // target date: today's staker set applied to a past balance sheet would
    // credit stakes that had not been made yet.
    if (ARG_AS_OF) return readCommittedJson("public/data/funding-wallets.json", ARG_AS_OF);
    return await readJson(path.resolve(process.cwd(), "public/data/funding-wallets.json"));
  } catch (error) {
    console.warn("Could not load funding-wallets.json:", error.message);
    return null;
  }
};

const addToCategory = (metrics, category, balance) => {
  metrics[category].count += 1;
  metrics[category].balance += balance;
};

const buildOutputSkeleton = (chainConfig) => {
  const chainEntries = {};
  for (const [key, metadata] of Object.entries(chainConfig)) {
    chainEntries[key] = { ...metadata, metrics: createEmptyMetrics(), holders: [] };
  }
  return {
    generatedAt: new Date().toISOString(),
    thresholds: { retail: RETAIL_THRESHOLD, megaHolder: MEGA_HOLDER_THRESHOLD, minTelRaw: MIN_TEL_RAW },
    // Populated by computeSupplyTotals() once wallets are built.
    totals: { totalSupply: 0 },
    chains: chainEntries,
    combined: createEmptyMetrics(),
    wallets: [],
    chainOrder: Object.keys(chainConfig),
  };
};

const compileExclusionSets = (exclusions, { cexSet = new Set(), dexSet = new Set() } = {}) => {
  const globalSet = new Set();
  const reportInvalid = (address, scope) => {
    if (!address || typeof address !== "string") return;
    console.warn(`Skipping invalid ${scope} exclusion address: ${address}`);
  };
  for (const address of exclusions.addresses ?? []) {
    const normalized = normalizeAddress(address);
    if (normalized) globalSet.add(normalized);
    else reportInvalid(address, "global");
  }
  // CEX + DEX must be excluded at RPC time — otherwise the next scheduled run
  // reinflates retail by every exchange/pool balance still sitting in the
  // Transfer-log reconstruction (historically ~8.6B CEX + ~11M DEX pools).
  for (const address of cexSet) globalSet.add(address);
  for (const address of dexSet) globalSet.add(address);

  const chainSets = {};
  for (const [key, info] of Object.entries(exclusions.chains ?? {})) {
    const chainSet = new Set();
    for (const address of info.addresses ?? []) {
      const normalized = normalizeAddress(address);
      if (normalized) chainSet.add(normalized);
      else reportInvalid(address, `${key}`);
    }
    chainSets[key] = chainSet;
  }
  // Addresses grouped by their `labels` category (bridge-lock, escrow, council,
  // treasury, staking-contract, cex, dex, burn). Unlabelled exclusions are still
  // excluded — they just can't be attributed to a category in the reconciliation.
  const byCategory = {};
  for (const [address, meta] of Object.entries(exclusions.labels ?? {})) {
    const normalized = normalizeAddress(address);
    const category = meta?.category;
    if (!normalized || !category) continue;
    (byCategory[category] ??= new Set()).add(normalized);
  }
  return { globalSet, chainSets, byCategory };
};

const formatDate = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
};

/**
 * @param {string} chainKey
 * @param {object} chainConfig
 * @param {string} topic0
 * @param {{ lastBlock: number, rawBalances: Record<string,string> } | null} checkpoint
 */
async function fetchChainBalances(chainKey, chainConfig, topic0, checkpoint = null) {
  const settings = CHAIN_RPC_SETTINGS[chainKey];
  if (!settings) {
    return { chainKey, balances: new Map(), checkpointData: null };
  }
  const rpcUrls = await getUsableRpcUrls(chainKey);
  if (rpcUrls.length === 0) {
    console.warn(`No RPC URLs for ${chainKey}; skipping.`);
    return { chainKey, balances: new Map(), checkpointData: null };
  }
  console.log(`  Using ${rpcUrls.length} RPC URL(s) for ${chainKey} (concurrency = ${rpcUrls.length}).`);

  const meta = chainConfig[chainKey];
  // Token addresses and decimals come from config (per token), never from a
  // hardcoded constant: legacy TEL is 2 decimals, TEL v3 is 18.
  const tokens = resolveChainTokens({ ...meta, key: chainKey });
  const tokenAddress = tokens.legacy.address;
  const decimals = tokens.legacy.decimals;
  const configuredFromBlock = Number(meta?.fromBlock);
  const genesisBlock = Number.isFinite(configuredFromBlock)
    ? configuredFromBlock
    : DEFAULT_FROM_BLOCK[chainKey] ?? 0;

  // If we have a checkpoint, resume from the block after the last scanned block.
  const fromBlock = checkpoint ? checkpoint.lastBlock + 1 : genesisBlock;
  const resuming = checkpoint && Object.keys(checkpoint.rawBalances ?? {}).length > 0;

  let chunkSize = settings.defaultChunkSize;
  const envChunk = process.env[settings.envChunkKey];
  if (envChunk != null) {
    const n = Number(envChunk);
    if (Number.isFinite(n) && n > 0) {
      chunkSize = chainKey === "polygon" ? Math.min(n, 2000) : Math.min(n, 50000);
    }
  }

  if (resuming) {
    console.log(`Resuming ${chainKey} from block ${fromBlock} (checkpoint has ${Object.keys(checkpoint.rawBalances).length} addresses)...`);
  } else {
    console.log(`Full scan: ${chainKey} Transfer logs from block ${fromBlock} (chunk ${chunkSize})...`);
  }

  const builder = buildBalanceMap(decimals, checkpoint?.rawBalances ?? {});

  // One head block for both tokens (see streamTransferLogs).
  const headBlock = Number.parseInt(String(await rpcCall(rpcUrls[0], "eth_blockNumber", [])), 16);
  const { totalLogs, latestBlock } = await streamTransferLogs(
    rpcUrls, tokenAddress, topic0, fromBlock, chunkSize, builder.onBatch, headBlock
  );

  // TEL v3 (18 decimals): scanned from its deployment block, independently
  // checkpointed, and combined per wallet with the legacy balance. A chain
  // without a configured v3 token behaves exactly as before.
  let v3Result = null;
  if (tokens.v3) {
    v3Result = await scanV3(chainKey, rpcUrls, tokens, topic0, headBlock, chunkSize, checkpoint?.v3 ?? null);
  }

  const combined = combineChainBalances({
    legacyRaw: builder.rawBalances(),
    legacyDecimals: decimals,
    v3Raw: v3Result?.state.raw ?? new Map(),
    v3Decimals: tokens.v3?.decimals ?? 18,
    retired: v3Result?.state.retired ?? new Map(),
  });
  if (combined.negativeRetired.length > 0) {
    console.warn(
      `WARNING: ${chainKey}: retired legacy exceeds the held balance for ${combined.negativeRetired.length} ` +
        `upgrade contract(s) (${combined.negativeRetired.join(", ")}) — scan is incomplete for them; clamped to 0.`
    );
  }

  const rawState = builder.getRawState();
  const balances = combined.balances;
  console.log(
    `  ${chainKey}: ${totalLogs} new logs → ${balances.size} holders with > 0 TEL (scanned to block ${latestBlock})` +
      (v3Result
        ? ` | v3 ${v3Result.v3Logs} logs, supply ${Math.round(combined.totals.v3).toLocaleString()}, ` +
          `retired legacy ${Math.round(combined.totals.retiredLegacy).toLocaleString()}`
        : "")
  );

  // Stranded = legacy TEL left on an upgrade contract after netting out what was
  // swapped (a plain transfer with no v3 mint). Still counted once, on the contract.
  const stranded = tokens.escrow.reduce((acc, addr) => acc + (balances.get(addr) ?? 0), 0);

  return {
    chainKey,
    balances,
    v3ByAddress: combined.v3ByAddress,
    tokenTotals: { ...combined.totals, strandedInUpgrade: stranded },
    checkpointData: {
      lastBlock: latestBlock,
      rawBalances: rawState,
      ...(v3Result ? { v3: v3StateToCheckpoint(v3Result.state, v3Result.toBlock) } : {}),
    },
  };
}

// Alchemy PAYG caps Polygon getLogs at 2000 blocks; v3 logs are sparse, so the
// other chains take a wide range. Overridable per chain for public RPCs.
const V3_CHUNK_DEFAULTS = { ethereum: 100_000, polygon: 2_000, base: 100_000 };

async function scanV3(chainKey, rpcUrls, tokens, topic0, toBlock, legacyChunkSize, checkpoint) {
  const envChunk = Number(process.env[`${chainKey.toUpperCase()}_V3_GETLOGS_CHUNK_SIZE`]);
  const chunkSize = Number.isFinite(envChunk) && envChunk > 0 ? envChunk : (V3_CHUNK_DEFAULTS[chainKey] ?? legacyChunkSize);
  const deployBlock = tokens.v3.deployBlock;
  if (!deployBlock) {
    throw new Error(`${chainKey}: tokens.v3.deployBlock is missing in config/chains.json — refusing to scan v3 from genesis`);
  }
  const resumeFrom = checkpoint ? checkpoint.lastBlock + 1 : deployBlock;
  console.log(`  ${chainKey}: TEL v3 scan from block ${resumeFrom}${checkpoint ? " (checkpoint)" : " (deployment block)"} to ${toBlock}, chunk ${chunkSize}`);
  const escrowTopics = tokens.escrow.map((a) => "0x" + a.slice(2).padStart(64, "0"));
  const logsFor = (address, topics) => (from, to) => {
    if (topics === null) return Promise.resolve([]);
    return getLogsWithFailover(rpcUrls, from % rpcUrls.length, {
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
      address,
      topics,
    });
  };
  const result = await scanV3Chain({
    deployBlock,
    toBlock,
    chunkSize,
    concurrency: rpcUrls.length,
    checkpoint,
    cfg: { escrow: tokens.escrow, legacyDecimals: tokens.legacy.decimals, v3Decimals: tokens.v3.decimals },
    fetchV3: logsFor(tokens.v3.address, [topic0]),
    // topic[2] = recipient: legacy TEL moving INTO an upgrade contract.
    fetchEscrowLegacy: logsFor(tokens.legacy.address, escrowTopics.length ? [topic0, null, escrowTopics] : null),
  });
  return result;
}

async function main() {
  const [chainConfig, exclusions, fundingWallets, checkpoint] = await Promise.all([
    loadChainConfig(),
    loadExclusions(),
    loadFundingWallets(),
    loadCheckpoint(),
  ]);

  if (checkpoint) {
    console.log(`Loaded checkpoint from ${checkpoint.generatedAt}`);
  } else {
    console.log("No checkpoint found — performing full scan from genesis blocks.");
  }

  const topic0 = getTransferTopic0();
  const chainBalancesRaw = { ethereum: new Map(), polygon: new Map(), base: new Map() };
  // v3 (18-decimal) share of each wallet's balance, per chain, in TEL. Already
  // INCLUDED in chainBalancesRaw (which is legacy + v3 combined); kept separately
  // only so the snapshot can show the split. Empty when v3 is not configured.
  const v3ByChain = { ethereum: new Map(), polygon: new Map(), base: new Map() };
  // Per-chain token totals (legacy supply, v3 supply, retired legacy, stranded)
  // feeding the supply identity; null until a live scan fills them in.
  const tokenTotalsByChain = {};
  // Seeded from the EXISTING checkpoint, not empty — a chain that fails below
  // must keep its last-known-good entry rather than have it silently dropped
  // when we save. saveCheckpoint() replaces `chains` wholesale (no merge with
  // what's on disk), so if this started empty, one failed chain would erase
  // every other chain's un-related, already-scanned checkpoint on write.
  const newCheckpointChains = { ...(checkpoint?.chains ?? {}) };

  if (ARG_AS_OF) {
    const blockMap = JSON.parse(await fs.readFile(AS_OF_BLOCKS_PATH, "utf8"))[ARG_AS_OF];
    if (!blockMap) throw new Error(`No day-boundary blocks recorded for ${ARG_AS_OF} in ${AS_OF_BLOCKS_PATH}`);
    const anchor = readCommittedJson("public/data/holders-checkpoint.json", ARG_ANCHOR_DATE);
    console.log(`Reconstructing ${ARG_AS_OF} from the ${ARG_ANCHOR_DATE} checkpoint + cached transfer logs.`);
    for (const chainKey of Object.keys(chainBalancesRaw)) {
      // A reconstructed day is legacy-only (the anchor checkpoint and the cached
      // transfer logs predate v3). That is exactly right BEFORE v3 existed (v3
      // balances are zero), and silently wrong after — swapped TEL would sit in
      // the upgrade contract with no v3 counterpart. Refuse rather than publish.
      const v3Deploy = resolveChainTokens({ ...chainConfig[chainKey], key: chainKey }).v3?.deployBlock;
      if (v3Deploy && blockMap[chainKey] >= v3Deploy) {
        throw new Error(
          `--as-of=${ARG_AS_OF} is at or after the TEL v3 deployment on ${chainKey} (block ${v3Deploy}); ` +
            `historical reconstruction only covers the legacy token. Dates before v3 are unaffected.`
        );
      }
      const anchorChain = anchor.chains?.[chainKey];
      if (!anchorChain) throw new Error(`Anchor checkpoint has no ${chainKey} chain`);
      // Prefers the local cache, falls back to fetching just this window so a
      // CI runner (where the multi-GB caches are gitignored) can do this too.
      const transfersPath = await ensureWindowCache({
        chainKey,
        fromBlock: anchorChain.lastBlock,
        toBlock: blockMap[chainKey],
        contractAddress: chainConfig[chainKey]?.tokenAddress,
        rpcUrl: (await getUsableRpcUrls(chainKey))[0],
      });
      const raw = await replayChainRawBalances({
        anchorChain,
        transfersPath,
        toBlock: blockMap[chainKey],
      });
      // Same dust/positive filter and decimal scaling as buildBalanceMap().finalize().
      const decimals = Number.isFinite(Number(chainConfig[chainKey]?.decimals))
        ? Number(chainConfig[chainKey].decimals)
        : 2;
      const balances = new Map();
      for (const [addr, value] of raw) {
        if (value < BigInt(MIN_TEL_RAW)) continue;
        const human = Number(value) / Math.pow(10, decimals);
        if (human > 0) balances.set(addr, human);
      }
      chainBalancesRaw[chainKey] = balances;
      console.log(`  ${chainKey}: ${balances.size} holders at block ${blockMap[chainKey]}`);
    }
    // No checkpoint write: the checkpoint tracks the LIVE scan frontier, and
    // rewinding it to a past block would make the next incremental run replay
    // (and double-count) everything since.
  } else {
    // Chains run concurrently — they hit entirely separate RPC endpoints (their
    // own dedicated key pools), so one chain's rate limiting never throttles
    // another's. Sequential used to be justified as "avoid holding all three
    // chains' logs in memory at once", but streamTransferLogs() already
    // processes and discards each chunk's raw logs via onBatch before fetching
    // the next (see its own docstring) — only the small per-chain balance Map
    // persists, tens of thousands of entries at most, negligible either way.
    // The real cost of sequential was leaving Polygon's 3 keys and Base's key
    // completely idle while a single-key, rate-limited Ethereum chain ground
    // through a catch-up alone — on a multi-day gap that's hours of wasted
    // parallelism for no memory benefit actually realized.
    //
    // allSettled, not all: a bare 503 ("Unable to complete request at this
    // time") from one chain used to reject the whole Promise.all and discard
    // every chain's in-progress scan, including two that had nothing to do
    // with the failing request and may have been minutes from finishing a
    // multi-hour catch-up. Each chain's outcome is now handled independently —
    // a failure costs only that chain's unsaved progress, not everyone else's.
    const chainSettled = await Promise.allSettled(
      Object.keys(chainConfig)
        .filter((chainKey) => CHAIN_RPC_SETTINGS[chainKey])
        .map(async (chainKey) => {
          const chainCheckpoint = checkpoint?.chains?.[chainKey] ?? null;
          const result = await fetchChainBalances(chainKey, chainConfig, topic0, chainCheckpoint);
          return { chainKey, ...result };
        }),
    );
    const failedChains = [];
    for (const settled of chainSettled) {
      if (settled.status === "rejected") {
        // We don't know which chainKey failed from a rejection alone (the
        // mapper closure's identity isn't on the reason), so log the raw error
        // for the operator and let the missing chainKey's balances stay the
        // empty Map from initialisation — caught by the completeness check below.
        console.error(`A chain scan failed: ${settled.reason?.message ?? settled.reason}`);
        failedChains.push(settled.reason);
        continue;
      }
      const { chainKey, balances, checkpointData, v3ByAddress, tokenTotals } = settled.value;
      chainBalancesRaw[chainKey] = balances;
      if (v3ByAddress) v3ByChain[chainKey] = v3ByAddress;
      if (tokenTotals) tokenTotalsByChain[chainKey] = tokenTotals;
      if (checkpointData) newCheckpointChains[chainKey] = checkpointData;
    }

    // Save whatever succeeded BEFORE anything else can throw and lose it — the
    // RPC scan is the expensive, rate-limited part of this script by orders of
    // magnitude; everything after it (staker merge, file writes) is cheap and
    // can safely be re-run. Moved out of its old position at the very end of
    // main(), which meant a crash anywhere later in the script — not just in
    // the scan — discarded a completed multi-hour scan for nothing.
    if (Object.keys(newCheckpointChains).length > 0) {
      await saveCheckpoint(newCheckpointChains);
      console.log(`Saved checkpoint to ${CHECKPOINT_PATH} (${chainSettled.length - failedChains.length}/${chainSettled.length} chains succeeded this run).`);
    }

    if (failedChains.length > 0) {
      // Refuse to write tel-holders.json / holders-summary.json: they need a
      // complete, consistent set of all three chains, and a failed chain's
      // Map is still empty here — writing it would publish that chain's
      // holders as having vanished, not as "not scanned this run". The
      // checkpoint above already preserved every chain's progress, including
      // the failed one's last-known-good state, so a re-run resumes cleanly
      // and only re-does the chain(s) that failed.
      console.error(
        `\n${failedChains.length} of ${chainSettled.length} chain(s) failed to scan. ` +
          `Checkpoint saved for the rest — re-run to retry just the failed chain(s). ` +
          `Not writing tel-holders.json/holders-summary.json from incomplete data.`,
      );
      process.exit(1);
    }
  }

  // Stakers transferred their TEL to the staking contract, so their Transfer-log
  // balance reconstructs to 0 and they disappear from the holder list.  Re-add
  // each current staker's stakedAmount as a Polygon balance so they are counted
  // as holders.  If a staker also holds liquid TEL their total = liquid + staked.
  if (fundingWallets?.wallets) {
    let stakersMerged = 0;
    let stakedAttributed = 0;
    for (const { fundingWallet: addr, stakedAmount } of fundingWallets.wallets) {
      const normalized = normalizeAddress(addr);
      if (!normalized || !Number.isFinite(stakedAmount) || stakedAmount <= 0) continue;
      const existing = chainBalancesRaw.polygon.get(normalized) ?? 0;
      chainBalancesRaw.polygon.set(normalized, existing + stakedAmount);
      stakedAttributed += stakedAmount;
      stakersMerged++;
    }
    console.log(`Merged ${stakersMerged} staker addresses into polygon balance map.`);

    // The staking contract's own balance is excluded, then re-attributed to the
    // individual stakers above. Attributed staking must therefore never exceed
    // what the contract actually custodies — if it does, we are crediting holders
    // with TEL that does not exist on chain, inflating totalBalance and totalHeld.
    //
    // This currently trips: ~4.597B attributed vs ~4.085B held by the contract,
    // a ~512M (12.5%) overstatement. Consistent with pull-staker-balances.js
    // deduping Etherscan `tokentx` rows by `tx.hash` alone — one transaction can
    // carry several TEL transfers, so every transfer after the first in a batched
    // tx is dropped, skewing the net deposit/withdrawal maths.
    const contractBalance = chainBalancesRaw.polygon.get(STAKING_CONTRACT_ADDRESS) ?? 0;
    if (contractBalance > 0 && stakedAttributed > contractBalance * (1 + STAKING_TOLERANCE)) {
      console.warn(
        `WARNING: attributed staking ${Math.round(stakedAttributed).toLocaleString()} TEL exceeds the ` +
          `staking contract's balance ${Math.round(contractBalance).toLocaleString()} TEL by ` +
          `${Math.round(stakedAttributed - contractBalance).toLocaleString()} TEL. ` +
          `Holder balances are overstated by that amount — see pull-staker-balances.js transfer dedup.`
      );
    }

    // Retire the staked TEL from the contract's OWN balance, now that the same
    // tokens are represented on each staker's entry above. The contract was only
    // ever excluded from the RETAIL set — it stayed in the chain balance map, so
    // its custodied TEL was counted a second time in the chain total and in
    // supply. That inflated Polygon to 41.18B against a real on-chain
    // totalSupply() of 37.25B, and produced a ~4B phantom `mirrorResidual`
    // implying the bridge was under-collateralised when it is fully backed
    // (predicate locks 37,249,704,874 vs Polygon's 37,248,867,603).
    //
    // Subtracting rather than zeroing is deliberate and self-correcting: whatever
    // the attribution could NOT place with an owner stays on the contract, so it
    // is still counted exactly once instead of vanishing from supply.
    if (contractBalance > 0) {
      const residual = residualCustodyBalance(contractBalance, stakedAttributed);
      chainBalancesRaw.polygon.set(STAKING_CONTRACT_ADDRESS, residual);
      console.log(
        `Staking contract balance ${Math.round(contractBalance).toLocaleString()} -> ` +
          `${Math.round(residual).toLocaleString()} TEL after attributing ` +
          `${Math.round(stakedAttributed).toLocaleString()} to stakers (prevents double-counting).`
      );
    }
  }

  const [cexSet, dexSet] = await Promise.all([loadCexAddressSet(), loadDexAddressSet()]);
  console.log(`Exclusion extras: ${cexSet.size} CEX + ${dexSet.size} DEX addresses merged into global set.`);
  const { globalSet, chainSets, byCategory } = compileExclusionSets(exclusions, { cexSet, dexSet });
  const output = buildOutputSkeleton(chainConfig);
  if (ARG_AS_OF) output.generatedAt = `${ARG_AS_OF}T23:59:59.000Z`;

  const allAddresses = new Set();
  for (const m of Object.values(chainBalancesRaw)) {
    for (const addr of m.keys()) allAddresses.add(addr);
  }

  for (const address of allAddresses) {
    const chainBalances = {
      ethereum: chainBalancesRaw.ethereum.get(address) ?? 0,
      polygon: chainBalancesRaw.polygon.get(address) ?? 0,
      base: chainBalancesRaw.base.get(address) ?? 0,
    };
    const totalBalance = chainBalances.ethereum + chainBalances.polygon + chainBalances.base;
    if (totalBalance <= 0) continue;

    // `*_balance` is the wallet's TOTAL TEL on that chain (legacy + v3), so every
    // downstream consumer keeps working unchanged. The v3 share is added only when
    // non-zero, keeping pre-v3 snapshots byte-for-byte compatible.
    const v3Shares = {};
    for (const chainKey of Object.keys(v3ByChain)) {
      const v3 = v3ByChain[chainKey].get(address) ?? 0;
      if (v3 > 0) v3Shares[`${chainKey}_v3`] = v3;
    }
    output.wallets.push({
      address,
      ethereum_balance: chainBalances.ethereum,
      polygon_balance: chainBalances.polygon,
      base_balance: chainBalances.base,
      ...v3Shares,
      total_telcoin_balance: totalBalance,
    });

    for (const [chainKey, balance] of Object.entries(chainBalances)) {
      if (!Number.isFinite(balance) || balance <= 0) continue;
      const chainEntry = output.chains[chainKey];
      if (!chainEntry) continue;

      const isExcludedForThisChain = globalSet.has(address) || Boolean(chainSets[chainKey]?.has(address));
      if (isExcludedForThisChain) {
        addToCategory(chainEntry.metrics, "excluded", balance);
        addToCategory(output.combined, "excluded", balance);
        continue;
      }
      if (balance > MEGA_HOLDER_THRESHOLD) {
        addToCategory(chainEntry.metrics, "mega", balance);
        addToCategory(output.combined, "mega", balance);
        continue;
      }

      // Retail / underThreshold / holderCount computed after sort via
      // computeChainMetrics — keeps one definition of retail.count.
      chainEntry.holders.push({ address, balance });
    }
  }

  for (const entry of Object.values(output.chains)) {
    entry.holders.sort((a, b) => b.balance - a.balance);
    const fromHolders = computeChainMetrics(entry.holders, { retailThreshold: RETAIL_THRESHOLD });
    entry.metrics.holderCount = fromHolders.holderCount;
    entry.metrics.totalBalance = fromHolders.totalBalance;
    entry.metrics.retail = fromHolders.retail;
    entry.metrics.underThreshold = fromHolders.underThreshold;
  }

  // Rebuild combined holder metrics from per-chain results (excluded/mega were
  // already accumulated during the scan loop).
  output.combined.holderCount = 0;
  output.combined.totalBalance = 0;
  output.combined.retail = { count: 0, balance: 0 };
  output.combined.underThreshold = { count: 0, balance: 0 };
  for (const entry of Object.values(output.chains)) {
    output.combined.holderCount += entry.metrics.holderCount;
    output.combined.totalBalance += entry.metrics.totalBalance;
    output.combined.retail.count += entry.metrics.retail.count;
    output.combined.retail.balance += entry.metrics.retail.balance;
    output.combined.underThreshold.count += entry.metrics.underThreshold.count;
    output.combined.underThreshold.balance += entry.metrics.underThreshold.balance;
  }

  output.wallets.sort((a, b) => b.total_telcoin_balance - a.total_telcoin_balance);

  output.totals = computeSupplyTotals(
    output,
    chainConfig,
    byCategory["bridge-lock"] ?? new Set(),
    console,
    Object.keys(tokenTotalsByChain).length > 0 ? tokenTotalsByChain : null
  );

  output.source = {
    type: "rpc",
    snapshotDate: ARG_AS_OF ?? formatDate(new Date()),
    refreshedAt: output.generatedAt,
    upstream: "rpc",
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

  // A reconstructed snapshot is a historical row, not the newest state, so it
  // must not become "previous" for the live snapshot either.
  let priorSnapshot = null;
  try {
    const existing = ARG_AS_OF ? null : await fs.readFile(OUTPUT_PATH, "utf8");
    if (existing) priorSnapshot = JSON.parse(existing);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Unable to load previous snapshot for archival:", error);
    }
  }

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);

  if (priorSnapshot) {
    await fs.writeFile(PREVIOUS_SNAPSHOT_PATH, `${JSON.stringify(priorSnapshot, null, 2)}\n`, "utf8");
    console.log(`Archived prior snapshot to ${PREVIOUS_SNAPSHOT_PATH}`);
  }

  // Count unique stakers for informational logging.
  // The staker addresses are the `fundingWallet` values in funding-wallets.json
  // (not the previously-empty `stakers` sub-array).  They are already merged into
  // the polygon balance map above, so holderCount already includes them.
  let uniqueStakerCount = 0;
  if (fundingWallets?.wallets) {
    const uniqueStakers = new Set();
    for (const wallet of fundingWallets.wallets) {
      const addr = normalizeAddress(wallet.fundingWallet);
      if (addr) uniqueStakers.add(addr);
    }
    uniqueStakerCount = uniqueStakers.size;
    console.log(`Found ${uniqueStakerCount} unique staker addresses (merged into holder count)`);
  }

  const summary = buildSummary(output, { snapshotDate: output.source.snapshotDate });

  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Wrote ${SUMMARY_PATH}`);

  // Checkpoint is already saved (see the scan phase above, right after the
  // per-chain fetch) — reaching here means every chain succeeded and
  // newCheckpointChains hasn't changed since, so saving it again would only
  // rewrite an identical file with a newer timestamp.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
