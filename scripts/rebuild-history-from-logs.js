#!/usr/bin/env node
/**
 * rebuild-history-from-logs.js
 *
 * Rebuilds public/data/holders-history.json from scratch by replaying every TEL
 * Transfer log in block order and snapshotting at each date boundary.
 *
 * WHY, WHEN recompute-history-from-git.js ALREADY EXISTS
 *
 * That script re-derives past dates from committed tel-holders.json snapshots,
 * so its accuracy is capped by whatever the original scan recorded. Two limits
 * followed from that, both now removed:
 *
 *  - The 2026-02-28 MIN_TEL_RAW change (101 -> 1 raw units) meant wallets under
 *    ~1.01 TEL were never scanned before that date. No snapshot contains them,
 *    so no git replay can recover them, and the changelog recorded the boundary
 *    as `backfillStatus: "not-possible"`. That verdict assumed recovery needed
 *    archived STATE (eth_call at an old block), which public nodes gate behind a
 *    paid tier. It does not: a balance is determined by the Transfer logs before
 *    it, and logs are ordinary historical data. Replaying from genesis under
 *    today's threshold recovers exactly those wallets.
 *  - Per-date staking had to be inferred heuristically (scripts/lib/phantomStakers.js),
 *    because stakedBy() only reads current state. The contract also emits
 *    StakeChanged(address,uint256,uint256) with an ABSOLUTE newStake, so replaying
 *    those logs gives exact per-date stakes and retires the heuristic.
 *
 * The result is one methodology — today's — applied to true per-date balances
 * across the whole range, rather than a patchwork of whatever each historical
 * run happened to measure.
 *
 * TOKEN TRANSFERS: alchemy_getAssetTransfers, NOT eth_getLogs
 *
 * `eth_getLogs` is capped per call (2,000 blocks on Polygon — see
 * pull-holders-rpc.js's CHAIN_RPC_SETTINGS), so a multi-year replay means tens
 * of thousands of rate-limited chunk requests. `alchemy_getAssetTransfers`
 * (scripts/lib/alchemyTransfers.js) has no per-call block-range limit and
 * returns already-decoded transfers, cursor-paginated instead of chunked —
 * the same total data in far fewer round trips. The block range is still
 * sharded across every available RPC key (one contiguous sub-range per key,
 * fetched concurrently) purely for parallelism, since `pageKey` pagination is
 * sequential within one query; `partitionLogsByBoundary` re-sorts the merged
 * result before splitting at date boundaries, so shard completion order
 * doesn't matter. Fetched transfers are cached to `data/rebuild-transfers-
 * <chain>.json` (matching generate-tier-outflows.js's data/-not-public/
 * convention for non-servable scan state) so `--resume` skips re-fetching
 * entirely rather than needing partial-fetch bookkeeping across shards.
 *
 * STAKECHANGED: Etherscan, NOT Alchemy
 *
 * StakeChanged has no alchemy_getAssetTransfers equivalent — that endpoint
 * only covers token transfers, not arbitrary contract events. It could still
 * have used raw Alchemy `eth_getLogs` like the old token-replay path did, but
 * a free-tier Alchemy key caps `eth_getLogs` at a 10-BLOCK range per call —
 * verified directly against a live key (every call over that returned an
 * explicit "Under the Free tier plan..." error) — which makes a
 * genesis-to-head chunked scan practically impossible. `alchemy_getAssetTransfers`
 * has no such limit on any tier (also verified directly: a genesis-to-latest
 * query against the same free-tier key returned real data), which is *why*
 * that endpoint is used for token transfers above — but it doesn't apply to
 * StakeChanged. So staking replay uses `scripts/lib/etherscanMultiKey.js`'s
 * `fetchContractLogs`, which has no block-range cap, instead.
 *
 * Etherscan v2 is ALSO used as an INDEPENDENT cross-check on a sample of
 * addresses/dates for the TOKEN ledger (scripts/cross-check-rebuild-etherscan.js)
 * — never merged into this ledger. Two providers can each be internally
 * correct and still disagree at the margins (decimal handling, indexing lag);
 * interleaving their rows into one balance ledger would turn that
 * disagreement into silent corruption instead of a visible, checkable
 * mismatch. See scripts/verify-staker-methods.js for the precedent this
 * follows: compute two ways, compare, never blend. Using Etherscan as the
 * PRIMARY source for staking (not just a cross-check) is a deliberate
 * exception to that pattern — StakeChanged has no Alchemy-side alternative to
 * cross-check against at this scale, so there is no second source to blend
 * with by mistake in the first place.
 *
 * MEMORY
 *
 * A full snapshot is ~100k addresses; ~230 dates x 3 chains would be ~69M
 * retained entries. So a snapshot is never stored: at each boundary it is
 * immediately reduced to the aggregates the history file needs, and dropped.
 * Two facts make that sufficient:
 *
 *  - combined.holderCount / totalBalance / distribution are per-(address,chain)
 *    ROW aggregates (see metricsForSnapshot in recompute-history-from-git.js —
 *    a wallet holding on two chains contributes two rows), so the combined view
 *    is the sum of the per-chain views. No cross-chain state needed.
 *  - concentration (top-N sums, N <= 1000) is NOT decomposable, so each chain
 *    retains only its top 1000 balances per date — 1000 numbers, not 100k.
 *
 * cumulativeHolders likewise avoids per-date address sets: the replay records
 * each address's FIRST date with a positive balance, and the cumulative count
 * at date D is then the number of addresses whose first date is <= D.
 *
 * Run: node scripts/rebuild-history-from-logs.js [--chain=polygon] [--resume]
 *                                                [--start=2026-01-01] [--dry-run]
 * Requires ENV_PASSPHRASE (decrypts .env.enc -> Alchemy RPC URLs). Public
 * endpoints refuse historical getLogs, so this only runs where that secret is
 * available — see .github/workflows/rebuild-holders-history.yml.
 */
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, rpcCall } from "./lib/rpc.js";
import { fetchAllTransfers } from "./lib/alchemyTransfers.js";
import { createEtherscanKeyPool, fetchContractLogs, keysFromEnv } from "./lib/etherscanMultiKey.js";
import { loadNonRetailSet, normalizeAddress } from "./lib/nonRetailSet.js";
import { computeChainMetrics, RETAIL_THRESHOLD } from "./lib/holderMetrics.js";
import { DISTRIBUTION_RANGES, CONCENTRATION_BUCKETS } from "./lib/holdersView.js";
import { STAKE_CHANGED_TOPIC0 } from "./lib/staking.js";
import { residualCustodyBalance } from "./lib/stakingCustody.js";
import { reconcileHistoryEntry } from "./lib/holderHistoryReconcile.js";
import {
  createReplayLedger,
  createStakeLedger,
  dailyBoundaries,
  findBlockAtTime,
  partitionLogsByBoundary,
  shardRange,
} from "./lib/historicalReplay.js";
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("rebuild-history-from-logs");

await loadEnv();

const ROOT = process.cwd();
const HISTORY_PATH = path.resolve(ROOT, "public/data/holders-history.json");
const CEX_HISTORY_PATH = path.resolve(ROOT, "public/data/cex-balance-history.json");
const EVER_CHECKPOINT_PATH = path.resolve(ROOT, "public/data/holders-ever-checkpoint.json");
const DATE_BLOCKS_PATH = path.resolve(ROOT, "public/data/date-blocks.json");
// Cached raw alchemy_getAssetTransfers results per chain — data/, not
// public/data/, matching generate-tier-outflows.js's convention for
// non-servable scan state. Lets --resume skip re-fetching entirely rather
// than needing partial-fetch bookkeeping across concurrently-fetched shards.
// Deliberately NOT holders-checkpoint.json: that file is the daily incremental
// pipeline's own state, and overwriting it with replay state would force the
// next scheduled run into a full rescan.
// .ndjson, not .json: a live rebuild run's Polygon shard fetched 8,638,698
// transfers, and a single JSON.stringify() over the whole array to write the
// cache threw "RangeError: Invalid string length" — a hard V8 ceiling on a
// single string (~512MB-1GB), independent of --max-old-space-size or
// available memory. Newline-delimited JSON writes and reads one record at a
// time via a stream, so no single string ever needs to hold more than one
// transfer's worth of text. See writeTransfersCache/readTransfersCache below.
const transfersCachePath = (chainKey) => path.resolve(ROOT, `data/rebuild-transfers-${chainKey}.ndjson`);

const STAKING_CONTRACT = "0x92e43aec69207755cb1e6a8dc589aae630476330";
const MIN_TEL_RAW = 1n; // matches pull-holders-rpc.js — any positive balance
const TOP_N = Math.max(...CONCENTRATION_BUCKETS);

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const onlyChain = flag("chain");
const startDate = flag("start", "2026-01-01");

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const readJsonOr = async (p, fallback) => {
  try { return await readJson(p); } catch { return fallback; }
};

/** Writes `transfers` to `p` as newline-delimited JSON, one record per line,
 *  via a stream — see transfersCachePath's comment for why a single
 *  JSON.stringify() over the whole array isn't safe at real chain volume. */
const writeTransfersCache = async (p, transfers) => {
  async function* lines() {
    for (const t of transfers) {
      yield JSON.stringify(t, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n";
    }
  }
  await pipeline(lines(), createWriteStream(p));
};

/** Reads a newline-delimited transfers cache back into an array, restoring
 *  `value` from its JSON-serialized string form to BigInt. Returns null if
 *  the file doesn't exist (mirrors readJsonOr's fallback behavior) — any
 *  other read/parse failure still throws, since a corrupt cache silently
 *  treated as "absent" would trigger a full re-fetch that masks the actual
 *  problem. */
const readTransfersCache = async (p) => {
  // createReadStream() never throws synchronously for a missing file — the
  // error surfaces asynchronously once the stream tries to open it, which is
  // why the ENOENT check lives around the iteration below, not around this
  // call.
  const transfers = [];
  try {
    for await (const line of createInterface({ input: createReadStream(p), crlfDelay: Infinity })) {
      if (!line) continue;
      const t = JSON.parse(line);
      t.value = BigInt(t.value);
      transfers.push(t);
    }
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return transfers;
};

/** StakeChanged log -> {account,newStake}. `newStake` is word 1 of `data`
 *  (declaration order: oldStake, newStake) — an ordering that
 *  scripts/verify-staker-methods.js confirms against stakedBy() before this
 *  script is trusted. See scripts/lib/staking.js for why that check exists. */
const parseStakeChanged = (log) => {
  const account = normalizeAddress("0x" + (log?.topics?.[1] ?? "").slice(-40));
  const data = (log.data ?? "").replace("0x", "");
  if (!account || data.length < 128) return null;
  return { account, newStake: BigInt("0x" + data.slice(64, 128)) };
};

/** Distribution buckets for a holder list, matching mapDistribution()'s shape. */
const buildDistribution = (holders) =>
  DISTRIBUTION_RANGES.map((range) => {
    const bucket = holders.filter((h) => h.balance >= range.min && h.balance < range.max);
    return {
      label: range.label,
      count: bucket.length,
      totalBalance: Math.round(bucket.reduce((s, h) => s + h.balance, 0)),
    };
  }).filter((row) => row.count > 0 || row.totalBalance > 0);

/** Combined distribution = per-bucket sum of the chain distributions. Valid
 *  because each (address, chain) pair is its own row (see header). */
const mergeDistributions = (perChain) => {
  const byLabel = new Map();
  for (const rows of perChain) {
    for (const row of rows) {
      const acc = byLabel.get(row.label) ?? { label: row.label, count: 0, totalBalance: 0 };
      acc.count += row.count;
      acc.totalBalance += row.totalBalance;
      byLabel.set(row.label, acc);
    }
  }
  return DISTRIBUTION_RANGES.map((r) => byLabel.get(r.label)).filter(Boolean).filter((r) => r.count > 0 || r.totalBalance > 0);
};

/** Top-N balance sums. Takes a pre-sorted descending balance array. */
const concentrationFromTop = (sortedDesc) => {
  const out = {};
  for (const bucket of CONCENTRATION_BUCKETS) {
    out[bucket] = Math.round(sortedDesc.slice(0, bucket).reduce((s, v) => s + v, 0));
  }
  return out;
};

/** Binary-searches each date's block, caching to disk — ~20 header reads per
 *  date per chain is slow to redo on every resume. Round-robins across every
 *  available key for the chain: a single-key version of this hammered
 *  rpcUrls[0] with ~5,800 sequential calls for a 232-date range (25 binary-
 *  search steps x 232 dates) and got HTTP 403'd by Alchemy mid-run, on a
 *  chain that had 3 keys sitting idle. */
async function resolveDateBlocks(chainKey, rpcUrls, boundaries, genesisBlock, headBlock, cache) {
  const key = chainKey;
  cache[key] = cache[key] ?? {};
  let cursor = 0;
  const getTimestamp = async (block) => {
    const rpcUrl = rpcUrls[cursor % rpcUrls.length];
    cursor += 1;
    const b = await rpcCall(rpcUrl, "eth_getBlockByNumber", ["0x" + block.toString(16), false]);
    return Number(BigInt(b.timestamp));
  };
  const out = [];
  for (const { date, seconds } of boundaries) {
    if (cache[key][date] == null) {
      const found = await findBlockAtTime(seconds, { low: genesisBlock, high: headBlock, getTimestamp });
      // A date before the token existed on this chain contributes nothing; pin
      // it to genesis so the snapshot is legitimately empty rather than skipped.
      cache[key][date] = found ?? genesisBlock;
      console.log(`  ${chainKey} ${date} -> block ${cache[key][date]}`);
    }
    out.push({ date, block: cache[key][date] });
  }
  return out;
}

async function main() {
  const { set: nonRetail, sizes } = await loadNonRetailSet();
  console.log(`Non-retail set: ${sizes.total} (exclusions ${sizes.exclusions}, CEX ${sizes.cex}, DEX ${sizes.dex}).`);

  const chainConfig = await readJson(path.resolve(ROOT, "config/chains.json"));
  const chainKeys = Object.keys(chainConfig).filter((k) => !onlyChain || k === onlyChain);
  const endDate = new Date().toISOString().slice(0, 10);
  const boundaries = dailyBoundaries(startDate, endDate);
  console.log(`Rebuilding ${boundaries.length} dates (${startDate} .. ${endDate}) for: ${chainKeys.join(", ")}`);

  // cex-balance-history.json is generated on its own (irregular, weekly-ish)
  // cadence by pull-cex-wallets.js — not something this log-replay can derive
  // itself, and not something to hold this rebuild hostage to. Carry forward
  // the nearest dated entry at or before each target date (same as-of pattern
  // recompute-history-from-git.js uses) so every rebuilt entry gets a real
  // cexBalance instead of silently defaulting to 0 — the gap this rebuild
  // previously left that made combined.totalHeld understate every date by the
  // full CEX-custody amount (see tasks/todo.md's 2026-08-22 balance-chart fix).
  const cexHistory = await readJsonOr(CEX_HISTORY_PATH, { entries: [] });
  const cexByDate = new Map((cexHistory.entries ?? []).map((e) => [e.date, e]));
  const cexHistoryDates = [...cexByDate.keys()].sort();
  // A date before cex-balance-history.json's first entry has no "as of"
  // match — fall back to 0 there would fabricate a fake CEX balance step
  // from 0 -> ~19.6B exactly on that first date instead of reflecting a gap
  // in how far back the archive goes. Carry the earliest known balance
  // backward instead (see the matching comment in recompute-history-from-git.js).
  const cexBalanceAsOf = (date) => {
    let match = null;
    for (const d of cexHistoryDates) {
      if (d > date) break;
      match = d;
    }
    match = match ?? cexHistoryDates[0];
    if (!match) return 0;
    return Number(cexByDate.get(match)?.total ?? 0) || 0;
  };

  const dateBlockCache = await readJsonOr(DATE_BLOCKS_PATH, {});

  // Staking replay uses Etherscan, not Alchemy — see the module header's
  // STAKECHANGED section for why. One pool covers every chain (Etherscan v2's
  // chainid parameter), so it's built once here rather than per-chain.
  const etherscanKeys = keysFromEnv();
  const etherscanPool = etherscanKeys.length ? createEtherscanKeyPool(etherscanKeys) : null;
  if (etherscanPool) console.log(`Etherscan key pool: ${etherscanPool.size} key(s), covers all chains.`);
  else console.log("No ETHERSCAN_API_KEY configured — staking replay will be skipped (stakingBalance=0).");

  // date -> chain -> aggregates. Never holds a full balance map.
  const perDate = new Map(boundaries.map((b) => [b.date, {}]));
  // address -> earliest date with a positive balance, for cumulativeHolders.
  const firstSeen = new Map();

  for (const chainKey of chainKeys) {
    const meta = chainConfig[chainKey];
    const rpcUrls = await getUsableRpcUrls(chainKey);
    if (!rpcUrls.length) throw new Error(`No RPC URLs for ${chainKey} — is ENV_PASSPHRASE set?`);
    const decimals = Number.isFinite(Number(meta?.decimals)) ? Number(meta.decimals) : 2;
    const genesis = Number(meta.fromBlock);
    const head = Number(BigInt(await rpcCall(rpcUrls[0], "eth_blockNumber", [])));

    console.log(`\n=== ${chainKey}: blocks ${genesis}..${head}, ${rpcUrls.length} Alchemy key(s) ===`);
    const dateBlocks = await resolveDateBlocks(chainKey, rpcUrls, boundaries, genesis, head, dateBlockCache);
    if (!dryRun) await fs.writeFile(DATE_BLOCKS_PATH, `${JSON.stringify(dateBlockCache, null, 2)}\n`, "utf8");

    // Polygon only: per-date stakes, replayed first so the Transfer pass can
    // merge them. Via Etherscan, not Alchemy raw eth_getLogs — see the
    // module header's STAKECHANGED section: free-tier Alchemy caps
    // eth_getLogs at 10 blocks/call (verified directly against a live key),
    // which makes a genesis-to-head chunked scan impractical, and
    // alchemy_getAssetTransfers doesn't cover arbitrary events like
    // StakeChanged (only token transfers). Etherscan's getLogs has no such
    // block-range cap.
    const stakesByDate = new Map();
    if (chainKey === "polygon" && etherscanPool) {
      const stakeLedger = createStakeLedger({ decimals });
      console.log(`  Fetching StakeChanged logs via Etherscan...`);
      const stakeLogs = await fetchContractLogs(etherscanPool, {
        chainId: meta.chainId, address: STAKING_CONTRACT, topic0: STAKE_CHANGED_TOPIC0,
        startBlock: genesis, endBlock: head,
      });
      console.log(`  Fetched ${stakeLogs.length} StakeChanged logs.`);
      const stakeRuns = partitionLogsByBoundary(stakeLogs, dateBlocks);
      for (const { logs, boundary } of stakeRuns) {
        stakeLedger.apply(logs.map(parseStakeChanged).filter(Boolean));
        if (boundary) stakesByDate.set(boundary.date, stakeLedger.snapshot());
      }
      console.log(`  Stake ledger: ${stakeLedger.size} accounts.`);
    } else if (chainKey === "polygon") {
      console.log(`  Skipping staking replay — no Etherscan key configured.`);
    }

    // Token transfers: alchemy_getAssetTransfers, sharded across every
    // available key for parallelism (see module header for why this
    // replaces chunked eth_getLogs here). Cached to disk so --resume skips
    // re-fetching entirely rather than needing partial-fetch bookkeeping
    // across concurrently-fetched shards.
    const cachePath = transfersCachePath(chainKey);
    let transfers = resume ? (await readTransfersCache(cachePath)) : null;
    if (transfers) {
      console.log(`  Using ${transfers.length} cached transfers from ${cachePath}.`);
    } else {
      const tokenAddress = (meta.tokenAddress ?? "").toLowerCase();
      const shards = shardRange(genesis, head, rpcUrls.length);
      console.log(`  Fetching transfers via alchemy_getAssetTransfers across ${shards.length} shard(s)...`);
      const shardResults = await Promise.all(
        shards.map(({ fromBlock, toBlock }, i) =>
          fetchAllTransfers(rpcUrls[i % rpcUrls.length], {
            fromBlock, toBlock, contractAddress: tokenAddress,
            onPage: (count) => console.log(`    shard ${i} (${fromBlock}-${toBlock}): ${count} transfers so far`),
          }),
        ),
      );
      transfers = shardResults.flat();
      console.log(`  Fetched ${transfers.length} total transfers.`);
      if (!dryRun) {
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await writeTransfersCache(cachePath, transfers);
      }
    }
    // transfers[].value is already BigInt here either way: fresh fetches
    // come straight from normalizeTransfer(), and readTransfersCache()
    // restores it from the cache's serialized string form itself.

    const ledger = createReplayLedger({ decimals, minRaw: MIN_TEL_RAW });
    const runs = partitionLogsByBoundary(transfers, dateBlocks);
    for (const { logs, boundary } of runs) {
      ledger.apply(logs);
      if (!boundary) continue;

      const balances = ledger.snapshot();

      // Merge staking exactly as pull-holders-rpc.js does: credit each staker,
      // then retire the contract's own balance down to whatever the
      // attribution could not place, so nothing is counted twice.
      if (chainKey === "polygon") {
        const stakes = stakesByDate.get(boundary.date) ?? new Map();
        let attributed = 0;
        for (const [account, staked] of stakes) {
          if (staked <= 0) continue;
          balances.set(account, (balances.get(account) ?? 0) + staked);
          attributed += staked;
        }
        const custody = balances.get(STAKING_CONTRACT) ?? 0;
        if (custody > 0) balances.set(STAKING_CONTRACT, residualCustodyBalance(custody, attributed));
      }

      const holders = [];
      for (const [address, balance] of balances) {
        if (nonRetail.has(address) || !(balance > 0)) continue;
        holders.push({ address, balance });
        const prior = firstSeen.get(address);
        if (prior === undefined || boundary.date < prior) firstSeen.set(address, boundary.date);
      }

      const metrics = computeChainMetrics(holders, { retailThreshold: RETAIL_THRESHOLD });
      const topBalances = holders.map((h) => h.balance).sort((a, b) => b - a).slice(0, TOP_N);
      perDate.get(boundary.date)[chainKey] = {
        holderCount: metrics.holderCount,
        retailHolderCount: metrics.retail.count,
        totalBalance: metrics.totalBalance,
        distribution: buildDistribution(holders),
        topBalances,
        stakingBalance: chainKey === "polygon"
          ? [...(stakesByDate.get(boundary.date) ?? new Map()).values()].reduce((s, v) => s + v, 0)
          : 0,
      };
      console.log(`  ${boundary.date} ${chainKey}: ${metrics.holderCount} holders, ${Math.round(metrics.totalBalance).toLocaleString()} TEL`);
    }
  }

  // Assemble entries. Combined is the row-wise sum of the chains (see header).
  const entries = [];
  const cumulativeByDate = new Map();
  let everCount = 0;
  const firstSeenCounts = new Map();
  for (const date of firstSeen.values()) firstSeenCounts.set(date, (firstSeenCounts.get(date) ?? 0) + 1);

  for (const { date } of boundaries) {
    const chains = perDate.get(date);
    if (!chains || !Object.keys(chains).length) continue;

    const newHolders = firstSeenCounts.get(date) ?? 0;
    everCount += newHolders;
    cumulativeByDate.set(date, everCount);

    const allTop = Object.values(chains).flatMap((c) => c.topBalances).sort((a, b) => b - a);
    const combined = {
      holderCount: 0, retailHolderCount: 0, totalBalance: 0, stakingBalance: 0,
    };
    for (const c of Object.values(chains)) {
      combined.holderCount += c.holderCount;
      combined.retailHolderCount += c.retailHolderCount;
      combined.totalBalance += c.totalBalance;
      combined.stakingBalance += c.stakingBalance;
    }
    combined.holderCountWithStakers = combined.holderCount;
    // cexBalance is a standalone field (see the comment above cexBalanceAsOf)
    // so the frontend can plot Retail/CEX/DEX independently; totalHeld stays
    // as their sum for the widgets that still read one blended figure
    // (HolderKpiHero / WalletHoldingsWidget delta baselines). dexLiquidity
    // isn't set by this script (needs backfill-dex-liquidity-history.js,
    // separately gated on ETHERSCAN_API_KEY), so it's omitted from the sum
    // here — reconciled to 0 the same way every other reader already treats
    // a missing dexLiquidity.
    const cexBalance = cexBalanceAsOf(date);
    combined.cexBalance = Math.round(cexBalance);
    combined.totalHeld = Math.round(combined.totalBalance + cexBalance);

    // DISTRIBUTION_RANGES floors at 1 TEL, so any sub-1-TEL wallet counts in
    // holderCount but lands in no bucket — reconcileHistoryEntry folds that
    // gap into the lowest bucket, the same treatment recompute-history-from-
    // git.js and holdersView.js already give every other holders-history
    // entry. Without it, this rebuild's own MIN_TEL_RAW=1 wallets (the sub-
    // 1.01-TEL population this whole rebuild exists to recover uniformly)
    // would violate holderCount === Σdistribution[].count on every entry.
    entries.push(reconcileHistoryEntry({
      date,
      generatedAt: `${date}T00:00:00.000Z`,
      combined,
      chains: Object.fromEntries(Object.entries(chains).map(([k, c]) => [k, {
        holderCount: c.holderCount,
        retailHolderCount: c.retailHolderCount,
        totalBalance: c.totalBalance,
        distribution: c.distribution,
        concentration: concentrationFromTop(c.topBalances),
      }])),
      distribution: mergeDistributions(Object.values(chains).map((c) => c.distribution)),
      concentration: concentrationFromTop(allTop),
      newHolders,
      cumulativeHolders: everCount,
    }));
  }

  console.log(`\nBuilt ${entries.length} entries. Cumulative holders: ${everCount}.`);
  if (dryRun) {
    console.log("--dry-run: nothing written.");
    console.log(JSON.stringify(entries.slice(-3), null, 2));
    return;
  }

  await fs.writeFile(
    HISTORY_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), source: "rebuild-history-from-logs", entries }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${HISTORY_PATH}`);

  await fs.writeFile(
    EVER_CHECKPOINT_PATH,
    JSON.stringify({
      generatedAt: entries[entries.length - 1]?.date ?? endDate,
      cumulativeHolders: everCount,
      addresses: [...firstSeen.keys()].sort(),
    }),
    "utf8",
  );
  console.log(`Wrote ${EVER_CHECKPOINT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
