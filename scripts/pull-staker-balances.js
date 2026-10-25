#!/usr/bin/env node
/**
 * pull-staker-balances.js
 *
 * Fetches TEL staker balances from the Polygon staking contract by:
 *   1. Reading the contract's own StakeChanged(address,uint256,uint256)
 *      event log, to discover the CANDIDATE address set (every account
 *      whose stake ever changed).
 *   2. Calling the contract's own stakedBy(address) view function for each
 *      candidate — authoritative, current, from the contract's accounting.
 *
 * Earlier versions computed balances by netting each candidate's own in/out
 * Transfer amounts. That silently overstated total staked by ~505.7M TEL
 * (12.1%) because this contract supports stakeFor(address,uint256) and
 * claimAndExitFor(address,address,bytes) — deposits/withdrawals can route
 * through an address other than the staker's own account, which per-address
 * netting cannot represent. Verified via the contract's implementation ABI
 * and by comparing against the contract's own totalStaked(). See
 * scripts/lib/staking.js and lessons.md for the full investigation.
 *
 * Candidate discovery ALSO used to read ERC-20 Transfer logs (same flaw:
 * stakeFor()/claimAndExitFor() let the true beneficiary never personally
 * touch a Transfer to/from the contract, so it was invisible to discovery
 * even though stakedBy() would have found it). That left an 8.41% (352.3M
 * TEL) gap between Σ stakedBy(candidates) and the contract's totalStaked().
 * Switched to scanning StakeChanged directly — the contract's own record of
 * every account whose stake ever changed — which closed the gap. See
 * scripts/lib/staking.js's STAKE_CHANGED_TOPIC0 comment for the investigation.
 *
 * Staking contract: 0x92e43Aec69207755CB1E6A8Dc589aAE630476330 (Polygon, proxy)
 * TEL token (Polygon): 0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32
 *
 * Outputs:
 *   public/data/funding-wallets.json
 *
 * The stakedBy() phase below is ~6,144 individual eth_call requests. Candidate
 * discovery (StakeChanged log scan) always goes through Etherscan — it's a
 * handful of paginated requests, not the bottleneck. stakedBy() itself
 * prefers Alchemy Polygon RPC (MATIC_RPC_0..9, decrypted from .env.enc via
 * ENV_PASSPHRASE — same keys pull-holders-rpc.js uses) when available,
 * spreading calls across every configured key the same way
 * pull-holders-rpc.js's streamTransferLogs does (concurrency = key count).
 * Etherscan's proxy module is the fallback when no Alchemy keys are
 * configured — that path is ~25+ minutes even under ideal rate limiting
 * (this key's actual cap is 3 calls/sec, see REQUEST_DELAY_MS below).
 * writeSnapshot() only runs at the very end either way. Any interruption (CI
 * timeout, killed process, environment restart) mid-run used to lose all
 * progress. public/data/staker-balances-checkpoint.json persists the
 * discovered candidate set plus every stakedBy() result queried so far
 * (including zero balances, so a real zero is never re-queried), so a
 * resumed run only queries what's left. Deleted on a fully successful run so
 * the next full scheduled run does fresh candidate discovery rather than
 * resuming forever against an aging candidate list.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, getPublicFallbackUrls, rpcCall, getLogs } from "./lib/rpc.js";
import { createLogsFailover } from "./lib/logsFailover.js";
import { scanStakeChangedCandidates } from "./lib/stakingDiscovery.js";
import { STAKED_BY_SELECTOR, TOTAL_STAKED_SELECTOR, STAKE_CHANGED_TOPIC0, decodeUint256, parseStakeChangedAccount } from "./lib/staking.js";
import { selectPipelineProject, projectPaths } from "./lib/projects.js";
import { resolveStakeChangedTarget } from "./lib/stakerTarget.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: the staking
// contract, its chain, the staked token and its decimals come from the
// project's `staking[]` entry with kind "stakeChanged" (TEL: the values that
// used to be hardcoded here), and output goes to the project's data dir.
const project = selectPipelineProject("pull-staker-balances", { ported: true });
const data = projectPaths(project);
const target = resolveStakeChangedTarget(project);
if (!target) {
  console.log(`[pull-staker-balances] project "${project.slug}" has no StakeChanged staking contract — nothing to do.`);
  process.exit(0);
}
const STAKING_CHAIN = target.chain;
const STAKING_CHAIN_ID = target.chainId;

await loadEnv();

// Probed, not just configured — see getUsableRpcUrls(). It throws when the
// entire pool is dead, which here must degrade to the Etherscan path below
// rather than abort the run, so the throw is caught deliberately.
const polygonRpcUrls = await getUsableRpcUrls(STAKING_CHAIN).catch((error) => {
  console.warn(`No usable Alchemy Polygon RPC (${error.message}) — falling back to Etherscan.`);
  return [];
});

// Keyless public Polygon endpoints, probed, for when there is neither a usable
// key nor an Etherscan API key (local recovery runs, or both quotas gone at
// once). getUsableRpcUrls() returns [] when no keys are configured at all
// (it only falls back to public when configured keys are all DEAD), so probe
// the public list here directly.
const probePublicPolygon = async () => {
  const urls = getPublicFallbackUrls(STAKING_CHAIN);
  const ok = await Promise.all(urls.map(async (url) => {
    try { await rpcCall(url, "eth_blockNumber", [], 5); return url; } catch { return null; }
  }));
  return ok.filter(Boolean);
};

const apiKey = process.env.ETHERSCAN_API_KEY;
const publicPolygonUrls = polygonRpcUrls.length === 0 ? await probePublicPolygon() : [];
// RPC pool for stakedBy()/totalStaked() eth_calls and keyless log discovery.
const rpcPool = polygonRpcUrls.length > 0 ? polygonRpcUrls : (apiKey ? [] : publicPolygonUrls);
const usingAlchemy = rpcPool.length > 0;
const publicSet = new Set(getPublicFallbackUrls(STAKING_CHAIN));
const rpcSource = rpcPool.length > 0 && rpcPool.every((u) => !publicSet.has(u)) ? "rpc-pool" : "public-rpc";

const OUTPUT_PATH = data("funding-wallets.json");
const CHECKPOINT_PATH = data("staker-balances-checkpoint.json");
const CHECKPOINT_MAX_AGE_MS = Number(process.env.STAKER_CHECKPOINT_MAX_AGE_MS) || 24 * 60 * 60 * 1000;

// Staking contract (TEL: Polygon proxy 0x92e43aec…6330) and the staked token
// (TEL: legacy TEL on Polygon, 2 decimals) — from project config.
const STAKING_CONTRACT = target.contract;
const TEL_TOKEN_POLYGON = target.tokenAddress;
const TEL_DECIMALS = target.decimals;
const TEL_DIVISOR = 10 ** TEL_DECIMALS;

const MAX_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 2000;
const PAGE_SIZE = 1000;
// This API key's actual enforced cap is 3 calls/sec (333ms min spacing) —
// 250ms (4/sec) tripped the "Max calls per sec rate limit reached (3/sec)"
// inline-throttle response on nearly every single stakedBy() call, forcing a
// 2000ms forced wait+retry per candidate. Over ~6,710 candidates that
// inflated a documented ~25min baseline run to 1h50m+ of near-continuous
// throttling (2026-08-15 run: 2151 throttle events logged). 400ms (2.5/sec)
// leaves real margin below the 3/sec ceiling instead of sitting right on it.
const REQUEST_DELAY_MS = Number(process.env.STAKER_REQUEST_DELAY_MS) || 400;

if (!apiKey && rpcPool.length === 0) {
  console.error("Missing ETHERSCAN_API_KEY and no usable Polygon RPC (keys or public) — cannot refresh stakers.");
  process.exit(1);
}
if (!apiKey) {
  console.log(`No ETHERSCAN_API_KEY — discovering candidates from StakeChanged logs over JSON-RPC (${rpcPool.length} URL(s)).`);
}

const baseUrl = (() => {
  const override = process.env.ETHERSCAN_API_BASE_URL?.trim();
  return override ? override.replace(/\/+$/, "") : "https://api.etherscan.io/v2/api";
})();

const normalizeAddress = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null;
};

const fetchWithRetry = async (url, attempt = 0) => {
  const response = await fetch(url);

  if (response.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.ceil(retryAfter * 1000)
      : RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.warn(`Rate limited. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES}).`);
    await delay(waitMs);
    return fetchWithRetry(url, attempt + 1);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  return response.json();
};

/**
 * Fetch all StakeChanged(address,uint256,uint256) logs from the staking
 * contract and return the set of unique `account` addresses — the
 * contract's own authoritative record of every account whose stake ever
 * changed, correctly including stakeFor()/claimAndExitFor() beneficiaries
 * who never personally transacted with the contract (see module comment
 * and scripts/lib/staking.js).
 *
 * Etherscan free tier: page × offset must be ≤ 10000, so we always use page=1
 * and advance startblock after each full page to stay within the limit.
 * Duplicate log rows at page boundaries are harmless here — we only keep the
 * unique account set, not the raw log records.
 */
const fetchStakeChangedCandidates = async () => {
  const candidates = new Set();
  let startBlock = 0;
  let totalLogs = 0;

  while (true) {
    const url = `${baseUrl}?chainid=${STAKING_CHAIN_ID}&module=logs&action=getLogs`
      + `&address=${STAKING_CONTRACT}&topic0=${STAKE_CHANGED_TOPIC0}`
      + `&fromBlock=${startBlock}&toBlock=latest`
      + `&page=1&offset=${PAGE_SIZE}`
      + `&apikey=${apiKey}`;

    console.log(`Fetching StakeChanged logs from block ${startBlock}...`);
    const data = await fetchWithRetry(url);

    if (data.status !== "1" || !Array.isArray(data.result)) {
      if (data.message === "No records found" || data.message === "No data found") {
        break;
      }
      if (data.result === "Max rate limit reached") {
        console.warn("Rate limit reached, waiting 1s...");
        await delay(1000);
        continue;
      }
      // Same class of bug scripts/lib/etherscanMultiKey.js already had to fix:
      // Etherscan's free-tier "Unexpected error, timeout or server too busy"
      // is transient (retry the SAME page), not fatal — a live daily-catchup
      // run hit exactly this message at block 76,135,673 (28,000 logs in)
      // and died outright with no retry.
      const text = `${data.message ?? ""} ${typeof data.result === "string" ? data.result : ""}`.toLowerCase();
      if (["timeout", "server too busy", "server error", "try again"].some((s) => text.includes(s))) {
        console.warn(`Transient Etherscan error (${data.message}), retrying in 2s...`);
        await delay(2000);
        continue;
      }
      throw new Error(`Etherscan API error: ${data.message ?? "unknown"} - ${JSON.stringify(data.result)}`);
    }

    for (const log of data.result) {
      const account = parseStakeChangedAccount(log, normalizeAddress);
      if (account) candidates.add(account);
    }
    totalLogs += data.result.length;
    console.log(`  Block ${startBlock}+: ${data.result.length} logs, ${candidates.size} unique accounts so far (total logs: ${totalLogs})`);

    if (data.result.length < PAGE_SIZE) {
      break; // last page
    }

    // Advance startblock to the last block seen so the next request stays
    // within the page×offset ≤ 10000 free-tier limit (always page=1).
    startBlock = Number(data.result[data.result.length - 1].blockNumber);
    await delay(REQUEST_DELAY_MS);
  }

  return candidates;
};

/** Keyless candidate discovery: StakeChanged logs straight from JSON-RPC eth_getLogs. */
const fetchStakeChangedCandidatesViaRpc = async (urls) => {
  const head = Number.parseInt(await rpcCall(urls[0], "eth_blockNumber", []), 16);
  const getLogsWithFailover = createLogsFailover(getLogs);
  // Discovery wants a URL that takes wide ranges first; rpc.getLogs bisects
  // for the ones that do not, so order only affects speed.
  const { candidates, logCount } = await scanStakeChangedCandidates({
    getLogsWithFailover,
    urls,
    contract: STAKING_CONTRACT,
    fromBlock: target.deployBlock,
    toBlock: head,
    normalize: normalizeAddress,
    log: (m) => console.log(m),
  });
  console.log(`  StakeChanged via RPC: ${logCount} logs up to block ${head}.`);
  return candidates;
};

/**
 * Reads a single view function's return value via Etherscan's `proxy` module
 * (eth_call). HTTP-level 429s are handled by fetchWithRetry; the proxy module
 * also signals free-tier throttling INLINE at HTTP 200 with a non-hex `result`
 * string (e.g. "Max rate limit reached") rather than an `error` object — with
 * ~2,835 sequential calls in a single run, that path is realistically hit and
 * must be retried, not misread as a zero balance.
 */
const ethCall = async (data, attempt = 0) => {
  const url = `${baseUrl}?chainid=${STAKING_CHAIN_ID}&module=proxy&action=eth_call`
    + `&to=${STAKING_CONTRACT}&data=${data}&tag=latest&apikey=${apiKey}`;
  const response = await fetchWithRetry(url);
  if (response.error) {
    throw new Error(`eth_call error: ${response.error.message ?? JSON.stringify(response.error)}`);
  }
  if (typeof response.result === "string" && !response.result.startsWith("0x")) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`eth_call non-hex result after ${MAX_RETRIES} retries: ${response.result}`);
    }
    const waitMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.warn(`eth_call throttled ("${response.result}"). Retrying in ${waitMs}ms...`);
    await delay(waitMs);
    return ethCall(data, attempt + 1);
  }
  return decodeUint256(response.result);
};

/** eth_call via Alchemy Polygon RPC (JSON-RPC) — rpcCall already retries HTTP 429 / -32005. */
const ethCallViaRpc = async (rpcUrl, data) => {
  const result = await rpcCall(rpcUrl, "eth_call", [{ to: STAKING_CONTRACT, data }, "latest"]);
  return decodeUint256(result);
};

/** Encodes calldata for stakedBy(address) using the pre-computed selector. */
const encodeStakedByCall = (address) => `${STAKED_BY_SELECTOR}${address.replace(/^0x/, "").padStart(64, "0")}`;

/**
 * Checkpoint schema: { schemaVersion, generatedAt, candidates: string[],
 * queried: { [address]: "<raw uint256 as string>" } }. `queried` includes
 * zero-balance results — presence in the map, not the value, marks an
 * address as already queried.
 */
const loadCheckpoint = async () => {
  if (process.env.STAKER_FORCE_FULL_RESCAN) {
    console.log("STAKER_FORCE_FULL_RESCAN set — ignoring any existing checkpoint.");
    return null;
  }
  try {
    const raw = await fs.readFile(CHECKPOINT_PATH, "utf8");
    const checkpoint = JSON.parse(raw);
    if (checkpoint?.schemaVersion !== 1) return null;
    const ageMs = Date.now() - Date.parse(checkpoint.generatedAt);
    if (!Number.isFinite(ageMs) || ageMs > CHECKPOINT_MAX_AGE_MS) {
      console.log(`Checkpoint is stale (${checkpoint.generatedAt}) — starting a fresh scan.`);
      return null;
    }
    return checkpoint;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    console.warn(`Failed to read checkpoint, starting fresh: ${error.message}`);
    return null;
  }
};

const saveCheckpoint = async (candidates, rawByAddress) => {
  const queried = {};
  for (const [address, value] of rawByAddress.entries()) queried[address] = String(value);
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidates: [...candidates],
    queried,
  };
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
  await fs.writeFile(CHECKPOINT_PATH, `${JSON.stringify(payload)}\n`, "utf8");
};

const deleteCheckpoint = async () => {
  await fs.rm(CHECKPOINT_PATH, { force: true });
};

/**
 * Queries stakedBy(address) for every candidate not already in `seedRaw`.
 * Prefers Alchemy Polygon RPC when configured, spreading requests across
 * every available key concurrently (one worker per key, same pattern as
 * pull-holders-rpc.js's streamTransferLogs) — each key's own rate limit is
 * well above Etherscan's, so this avoids the throttle wall entirely instead
 * of just pacing around it. Falls back to sequential Etherscan proxy calls,
 * paced to stay within its free-tier rate limit, when no Alchemy keys are
 * configured. Persists progress to the checkpoint every 200 queries so an
 * interrupted run only has to redo a couple of minutes of work, not the
 * whole scan. Returns raw (2-decimal) amounts, including zero-balance
 * entries.
 */
const fetchStakedByAll = async (candidates, seedRaw = new Map()) => {
  const raw = new Map(seedRaw);
  const remaining = [...candidates].filter((address) => !raw.has(address));
  if (seedRaw.size > 0) {
    console.log(`  Resuming from checkpoint: ${seedRaw.size} already queried, ${remaining.length} remaining.`);
  }
  if (remaining.length === 0) return raw;

  let queriedThisRun = 0;
  const maybeCheckpoint = async () => {
    queriedThisRun++;
    if (queriedThisRun % 200 === 0 || queriedThisRun === remaining.length) {
      console.log(`  stakedBy: ${raw.size}/${candidates.size} candidates queried...`);
      await saveCheckpoint(candidates, raw);
    }
  };

  if (usingAlchemy) {
    const concurrency = rpcPool.length;
    console.log(`  Using ${concurrency} Alchemy Polygon RPC URL(s) for stakedBy() (concurrency = ${concurrency}).`);
    await Promise.all(
      rpcPool.map(async (rpcUrl, workerIdx) => {
        for (let i = workerIdx; i < remaining.length; i += concurrency) {
          const address = remaining[i];
          const value = await ethCallViaRpc(rpcUrl, encodeStakedByCall(address));
          raw.set(address, value);
          await maybeCheckpoint();
        }
      })
    );
  } else {
    for (const address of remaining) {
      const value = await ethCall(encodeStakedByCall(address));
      raw.set(address, value);
      await maybeCheckpoint();
      await delay(REQUEST_DELAY_MS);
    }
  }
  return raw;
};

const writeSnapshot = async (wallets) => {
  const totalStaked = wallets.reduce((sum, w) => sum + w.stakedAmount, 0);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      type: "explorer",
      chain: STAKING_CHAIN,
      contractAddress: STAKING_CONTRACT,
      tokenAddress: TEL_TOKEN_POLYGON,
      api: baseUrl,
      // Candidate discovery (StakeChanged log scan) always goes through
      // Etherscan (`api` above); this only describes stakedBy()/totalStaked().
      // "alchemy" = configured key pool, "public-rpc" = keyless fallback.
      stakedByApi: usingAlchemy ? (rpcSource === "rpc-pool" ? "alchemy" : "public-rpc") : "etherscan",
      stakedByRpcKeyCount: rpcSource === "rpc-pool" ? rpcPool.length : 0,
      candidateDiscovery: apiKey ? "etherscan" : "json-rpc",
    },
    wallets,
    totals: {
      walletCount: wallets.length,
      stakedAmount: totalStaked,
      stakerCount: wallets.length,
    },
  };
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Saved ${wallets.length} staking wallets totaling ${totalStaked.toLocaleString()} TEL.`);
};

// How far the new total can drop vs the previous snapshot before we treat
// it as a data error.  40 % allows for genuine large unstaking events while
// catching truncated API responses that lose 70 %+ of the balance.
const STALE_DROP_THRESHOLD = 0.40;

const readPreviousTotal = async () => {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, "utf8");
    const prev = JSON.parse(raw);
    return Number(prev?.totals?.stakedAmount ?? 0) || 0;
  } catch {
    return 0;
  }
};

// How far Σ stakedBy(candidates) may diverge from the contract's own
// totalStaked() before we treat the candidate set as incomplete. Candidate
// discovery reads StakeChanged directly (see module comment), which should
// account for every staker exactly — a gap here now points at something more
// surprising than the old Transfer-log blind spot (e.g. a contract upgrade
// with a differently-shaped pre-upgrade event history). Kept as a safety net
// rather than removed: this can't fail the run, but it must not pass silently.
const RECONCILIATION_TOLERANCE = 0.01; // 1%

const main = async () => {
  console.log(`Fetching TEL staker balances (candidate discovery via Etherscan, chainid=${STAKING_CHAIN_ID})...`);
  console.log(`  Staking contract: ${STAKING_CONTRACT}`);
  console.log(`  TEL token:        ${TEL_TOKEN_POLYGON}`);
  console.log(
    usingAlchemy
      ? `  stakedBy() source: ${rpcSource} (${rpcPool.length} Polygon RPC URL(s))`
      : `  stakedBy() source: Etherscan (no Alchemy Polygon RPC keys configured — set ENV_PASSPHRASE to enable)`
  );

  const previousTotal = await readPreviousTotal();
  console.log(`Previous staked total: ${previousTotal.toLocaleString()} TEL`);

  const checkpoint = await loadCheckpoint();
  let candidates;
  let seedRaw = new Map();

  if (checkpoint) {
    candidates = new Set(checkpoint.candidates);
    seedRaw = new Map(Object.entries(checkpoint.queried).map(([addr, v]) => [addr, Number(v)]));
    console.log(`Resuming from checkpoint (${checkpoint.generatedAt}): ${candidates.size} candidates, ${seedRaw.size} already queried.`);
  } else {
    if (apiKey) {
      try {
        candidates = await fetchStakeChangedCandidates();
      } catch (error) {
        if (rpcPool.length === 0) throw error;
        console.warn(`Etherscan discovery failed (${error.message}) — falling back to JSON-RPC eth_getLogs.`);
        candidates = await fetchStakeChangedCandidatesViaRpc(rpcPool);
      }
    } else {
      candidates = await fetchStakeChangedCandidatesViaRpc(rpcPool);
    }

    if (candidates.size === 0) {
      console.warn("No StakeChanged logs found. Writing empty snapshot.");
      await writeSnapshot([]);
      return;
    }

    console.log(`Discovered ${candidates.size} candidate addresses via StakeChanged logs. Querying stakedBy() for each...`);
    // Persist the frozen candidate set immediately, before the long query
    // loop starts, so even an interruption before the first periodic save
    // still resumes from discovery rather than redoing it.
    await saveCheckpoint(candidates, seedRaw);
  }

  const rawByAddress = await fetchStakedByAll(candidates, seedRaw);

  const wallets = [];
  for (const [address, rawAmount] of rawByAddress.entries()) {
    const stakedAmount = rawAmount / TEL_DIVISOR;
    if (!Number.isFinite(stakedAmount) || stakedAmount <= 0) continue;
    wallets.push({
      fundingWallet: address,
      stakedAmount,
      stakers: [],
    });
  }

  const newTotal = wallets.reduce((sum, w) => sum + w.stakedAmount, 0);

  // Reconciliation: the sum of individually-queried balances should match the
  // contract's own totalStaked() almost exactly, since both read the same
  // underlying accounting. A gap beyond tolerance means the candidate set
  // missed some stakers (see comment on RECONCILIATION_TOLERANCE above).
  const contractTotalRaw = usingAlchemy
    ? await ethCallViaRpc(rpcPool[0], TOTAL_STAKED_SELECTOR)
    : await ethCall(TOTAL_STAKED_SELECTOR);
  const contractTotal = contractTotalRaw / TEL_DIVISOR;
  const reconciliationGap = Math.abs(newTotal - contractTotal);
  console.log(
    `Reconciliation: Σ stakedBy = ${newTotal.toLocaleString()} TEL vs totalStaked() = ` +
      `${contractTotal.toLocaleString()} TEL (gap ${reconciliationGap.toLocaleString()} TEL, ` +
      `${contractTotal > 0 ? ((reconciliationGap / contractTotal) * 100).toFixed(2) : "n/a"}%).`
  );
  if (contractTotal > 0 && reconciliationGap > contractTotal * RECONCILIATION_TOLERANCE) {
    console.warn(
      `WARNING: candidate set likely incomplete despite StakeChanged-based discovery — ` +
        `missing ${reconciliationGap.toLocaleString()} TEL of known stakers. Worth investigating ` +
        `(e.g. a contract upgrade with a different pre-upgrade event history).`
    );
  }

  // Sanity check: a snapshot more than STALE_DROP_THRESHOLD below the previous
  // one is normally a truncated/throttled API response, so it is refused.
  // BUT a drop is also exactly what the TEL v3 upgrade causes for real —
  // stakers must unstake legacy TEL before swapping it for v3, so the staking
  // contract's own totalStaked() fell from ~4.17B to ~0.80B TEL (verifiable
  // on-chain). Refusing on the drop alone therefore froze this feed forever
  // (2026-10-13: "new staked total (812,341,897 TEL) dropped >40% from previous
  // (4,173,035,603 TEL)" while totalStaked() read the same ~0.8B). So the drop
  // is only refused when the sum ALSO fails to reconcile with the contract's
  // totalStaked() read in this same run: a truncated response can't match it,
  // a genuine mass-unstake does.
  if (previousTotal > 0 && newTotal < previousTotal * (1 - STALE_DROP_THRESHOLD)) {
    const reconciled = contractTotal > 0 && reconciliationGap <= contractTotal * RECONCILIATION_TOLERANCE;
    if (!reconciled) {
      console.error(
        `FEED ERROR: new staked total (${newTotal.toLocaleString()} TEL, ${wallets.length} wallets) ` +
        `dropped >40% from previous (${previousTotal.toLocaleString()} TEL) and does not reconcile ` +
        `with totalStaked() (${contractTotal.toLocaleString()} TEL). ` +
        `Refusing to write snapshot — likely a truncated API response.`
      );
      process.exit(1);
    }
    console.warn(
      `Accepting >40% drop from ${previousTotal.toLocaleString()} to ${newTotal.toLocaleString()} TEL: ` +
      `it reconciles with on-chain totalStaked() (${contractTotal.toLocaleString()} TEL) — genuine unstaking ` +
      `(e.g. holders unstaking legacy TEL to upgrade to TEL v3), not a truncated response.`
    );
  }

  wallets.sort((a, b) => b.stakedAmount - a.stakedAmount);
  await writeSnapshot(wallets);
  await deleteCheckpoint();
};

main().catch((error) => {
  console.error("Failed to refresh staker balances:", error);
  process.exitCode = 1;
});
