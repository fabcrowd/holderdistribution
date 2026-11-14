#!/usr/bin/env node
/**
 * scan-exchange-flows.js
 *
 * Detects TEL that is actually deposited to / withdrawn from centralized
 * exchange wallets by scanning ERC-20 Transfer logs — the definitive
 * "are holders sending to exchanges" signal (vs. inferring from balance diffs).
 *
 * For every Transfer log:
 *   - `to`   ∈ CEX set  → exchange INFLOW  (deposit — potential sell pressure)
 *   - `from` ∈ CEX set  → exchange OUTFLOW (withdrawal — leaving exchanges)
 *   - `to`   ∈ DEX set  → DEX SELL  (TEL swapped into a pool for another coin)
 *   - `from` ∈ DEX set  → DEX BUY   (TEL swapped out of a pool to a wallet)
 * DEX pools are defined in config/dex-contracts.json (pair/pool contracts,
 * not routers — the pool is the definitive swap counterparty).
 * Amounts are bucketed by calendar day (UTC) using the block timestamp sampled
 * at each chunk boundary.
 *
 * Resumable & budget-bounded: each run scans up to MAX_BLOCKS_PER_RUN new
 * blocks per chain from a checkpoint, so a full backfill can be completed over
 * several manually-triggered runs without exceeding CI time limits.
 *
 * State (small — no address set is ever stored):
 *   public/data/exchange-flow-history.json  — { entries: [{date, chains:{eth,polygon,base:{in,out}}, in, out, net}] }  (servable)
 *   public/data/exchange-flow-checkpoint.json — { chains: { <chain>: { lastBlock } } }                                 (small)
 *
 * Required env: decrypted Alchemy RPC URLs (ETH_RPC_*, MATIC_RPC_*, BASE_RPC_*)
 * Optional env:
 *   MAX_BLOCKS_PER_RUN   — per-chain block budget for this run (default 3_000_000)
 *   FLOW_START_BLOCK_ETH / _POLYGON / _BASE — first block to scan if no checkpoint
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getUsableRpcUrls, getLogs, rpcCall } from "./lib/rpc.js";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectPaths, projectWork, projectChains, projectClassificationPath } from "./lib/projects.js";
import { exchangeFlowChains } from "./lib/exchangeFlowChains.js";
import { markPartialDay } from "./lib/partialDay.js";
import { readWindow, transferWindowName } from "./lib/transferWindow.js";
import { getTransferLogsCached, sharedScanEnabled } from "./lib/sharedTransferLogs.js";
import { cutoffScanWindow, readCutoffMap, asOfFromSolanaScan, asOfFromReached } from "./lib/dayBlocks.js";
import { loadChainAdapter, projectHasVm } from "./lib/chainAdapters.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: token addresses,
// decimals and start blocks come from the project's chain map, CEX/DEX lists
// from its classification config, and output goes to its data dir.
const project = selectPipelineProject("scan-exchange-flows", { ported: true });
const data = projectPaths(project);

await loadEnv();

const HISTORY_PATH = data("exchange-flow-history.json");
const CHECKPOINT_PATH = data("exchange-flow-checkpoint.json");
const CEX_CONFIG_PATH = projectClassificationPath(project, "cexWallets");
const DEX_CONFIG_PATH = projectClassificationPath(project, "dexContracts");

const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Sanity ceiling: a single transfer cannot exceed total supply (TEL ~100B ->
// 200e9). Larger values are corrupt / non-standard logs and are skipped.
const MAX_SANE_TEL = 2 * (Number(project.config?.supply?.target) || 100e9);

// Token contract per chain + a default start block (TEL: ≈ 1 year back, so the
// history covers the full 1Y timeframe, matching the tier-outflow scan).
// Token addresses come from the project's chain map (TEL: config/chains.json),
// never a literal here. Base was once hardcoded to 0xc2106ca7… (NFTEarthOFT,
// not TEL), so the Base leg silently matched nothing for months.
// Per-chain divisor = 10 ** the scanned token's decimals (TEL legacy: 100).
const CHAINS = exchangeFlowChains(project, projectChains(project), process.env);

// `??` only falls back on null/undefined — GitHub Actions sets this env var to
// an EMPTY STRING (not unset) on schedule-triggered runs, since
// `github.event.inputs.*` is only populated for workflow_dispatch. That made
// `Number("" ?? 3_000_000)` evaluate to `Number("")` = 0, silently turning
// every cron run into a scan-nothing no-op (see `if (from > end) return` on
// the same guard pattern as generate-tier-outflows.js) while manual runs
// looked fine. `||` treats "" as falsy too, so it now falls back correctly
// regardless of trigger type.
const MAX_BLOCKS_PER_RUN = Number(process.env.MAX_BLOCKS_PER_RUN) || 3_000_000;

const readOptionalJson = async (p) => {
  if (p === null) return null; // project declares no such list
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

const topicToAddress = (topic) =>
  typeof topic === "string" && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : null;

const hexToNumber = (hex) => parseInt(hex, 16);

const blockTimestampSec = async (rpcUrl, blockNumber) => {
  const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
  return block?.timestamp ? hexToNumber(block.timestamp) : null;
};

const scanChain = async (chainKey, cexSet, dexSet, checkpoint, dayBuckets) => {
  const cfg = CHAINS[chainKey];
  const rpcUrls = await getUsableRpcUrls(chainKey, { logRange: true });
  if (rpcUrls.length === 0) {
    console.warn(`  ${chainKey}: no RPC URLs configured — skipping.`);
    return;
  }
  const sharedWindow = sharedScanEnabled() ? await readWindow(projectWork(project)(transferWindowName(chainKey))) : null;

  const latest = hexToNumber(await rpcCall(rpcUrls[0], "eth_blockNumber", []));
  const from = checkpoint.chains?.[chainKey]?.lastBlock != null
    ? checkpoint.chains[chainKey].lastBlock + 1
    : cfg.defaultStart;
  // UTC-day buckets are exactly [cutoff[D], cutoff[D+1]) and the scan stops at
  // the settled end cutoff[today]-1 (scripts/lib/dayBlocks.js), so every
  // chain and every feed ends on the same block of the same day.
  const { end, dateOf } = await cutoffScanWindow({
    project, chain: chainKey, from, latest, maxBlocks: MAX_BLOCKS_PER_RUN,
    getBlockTimestamp: (b) => blockTimestampSec(rpcUrls[0], b),
  });
  if (from > end) {
    console.log(`  ${chainKey}: up to date (block ${from - 1}).`);
    return;
  }

  console.log(`  ${chainKey}: scanning ${from}..${end} (latest ${latest}) across ${rpcUrls.length} keys`);
  if (sharedWindow) console.log(`  ${chainKey}: shared transfer window ${sharedWindow.meta.fromBlock}-${sharedWindow.meta.toBlock} available.`);

  // Build ordered chunk list, process in parallel batches (one RPC key each).
  const chunks = [];
  for (let start = from; start <= end; start += cfg.chunk) {
    chunks.push([start, Math.min(start + cfg.chunk - 1, end)]);
  }
  const conc = Math.min(rpcUrls.length, 8);
  let lastGood = from - 1;
  let matched = 0;
  let aborted = false;

  for (let i = 0; i < chunks.length && !aborted; i += conc) {
    const batch = chunks.slice(i, i + conc);
    const results = await Promise.allSettled(
      batch.map(([start, stop], j) =>
        getTransferLogsCached({
          window: sharedWindow,
          chain: chainKey,
          tokens: [cfg.token],
          fromBlock: start,
          toBlock: stop,
          fetchFromRpc: () => getLogs(rpcUrls[j % rpcUrls.length], {
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${stop.toString(16)}`,
            address: cfg.token,
            topics: [TRANSFER_TOPIC0],
          }),
        }),
      ),
    );
    // Advance only over the contiguous successful prefix of this batch.
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status !== "fulfilled") {
        console.warn(`    ${chainKey} ${batch[j][0]}-${batch[j][1]}: ${r.reason?.message ?? "getLogs failed"}; stopping at ${lastGood}.`);
        aborted = true;
        break;
      }
      for (const log of r.value) {
        const fromAddr = topicToAddress(log.topics?.[1]);
        const toAddr = topicToAddress(log.topics?.[2]);
        const fromCex = fromAddr && cexSet.has(fromAddr);
        const toCex = toAddr && cexSet.has(toAddr);
        const fromDex = fromAddr && dexSet.has(fromAddr);
        const toDex = toAddr && dexSet.has(toAddr);
        if (!fromCex && !toCex && !fromDex && !toDex) continue;
        const value = Number(BigInt(log.data ?? "0x0")) / cfg.divisor;
        if (!Number.isFinite(value) || value <= 0 || value > MAX_SANE_TEL) continue;
        const date = dateOf(Number(log.blockNumber ? hexToNumber(log.blockNumber) : batch[j][0]));
        const bucket = dayBuckets.get(date) ?? { in: 0, out: 0, dexIn: 0, dexOut: 0, chains: {} };
        const cb = bucket.chains[chainKey] ?? { in: 0, out: 0, dexIn: 0, dexOut: 0 };
        // Exchange custody flows: deposit (in) vs withdrawal (out).
        if (toCex && !fromCex) { bucket.in += value; cb.in += value; matched++; }
        else if (fromCex && !toCex) { bucket.out += value; cb.out += value; matched++; }
        // DEX swap flows: TEL into a pool = sold for another coin (dexIn);
        // TEL out of a pool = bought with another coin (dexOut). CEX<->DEX
        // arbitrage legs are already counted on the CEX side above; only
        // count a DEX leg when the counterparty isn't a CEX wallet.
        if (toDex && !fromDex && !fromCex) { bucket.dexIn += value; cb.dexIn += value; matched++; }
        else if (fromDex && !toDex && !toCex) { bucket.dexOut += value; cb.dexOut += value; matched++; }
        bucket.chains[chainKey] = cb;
        dayBuckets.set(date, bucket);
      }
      lastGood = batch[j][1];
    }
  }

  checkpoint.chains = checkpoint.chains ?? {};
  checkpoint.chains[chainKey] = { lastBlock: lastGood };
  console.log(`  ${chainKey}: done to block ${lastGood} (${matched} CEX transfers matched)`);
};

// Solana-only project: the day store written by scan-solana-flows.js, completed
// UTC days (the open day included; markPartialDay flags it). Without Solana chains (or a store) the history stays empty.
const solanaEntries = async () => {
  const { solanaFlowChains } = await import("./lib/solana/flowConfig.js");
  const { buildExchangeHistory } = await import("./lib/solana/flowFeeds.js");
  const chains = solanaFlowChains(project.config);
  if (chains.length === 0) return null;
  const store = await readOptionalJson(projectWork(project)("solana-flow-days.json"));
  if (!store) return [];
  return buildExchangeHistory(store, { decimals: Object.fromEntries(chains.map((c) => [c.key, c.decimals])) });
};

// Hedera-only project (native coin): the day store written by scan-hedera-flows.js, same shape as Solana's.
// A project that mixes Hedera with EVM chains is refused: its flows could not be published from one scan.
const hederaKit = async () => {
  if (!projectHasVm(project.config, "hedera")) return null;
  if (Object.keys(CHAINS).length > 0) throw new Error(`${project.slug}: EVM and Hedera chains in one project are not supported by the flow feeds`);
  const kit = await (await loadChainAdapter("hedera")).flows();
  const chains = kit.hederaFlowChains(project.config);
  if (chains.length !== 1) throw new Error(`${project.slug}: expected one Hedera chain for the flow feeds, found ${chains.length}`);
  return { kit, ...chains[0] };
};

const hederaEntries = async () => {
  const hedera = await hederaKit();
  if (!hedera) return null;
  const { buildExchangeHistory } = await import("./lib/solana/flowFeeds.js");
  const store = await readOptionalJson(projectWork(project)("hedera-flow-days.json"));
  return store ? buildExchangeHistory(store, { decimals: { [hedera.key]: hedera.decimals } }) : [];
};

// Stamp from the blocks the scan actually reached (a MAX_BLOCKS_PER_RUN-capped
// backlog stamps its last complete day, not yesterday). Solana-only projects
// stamp from scan-solana-flows' checkpoint (same file): only a complete scan
// claims a settled day; an incomplete one stamps date null (asOfFromSolanaScan).
// Hedera-only projects stamp from scan-hedera-flows' checkpoint the same way (hederaFlowAsOf).
const projectAsOf = async (checkpoint) => {
  const hedera = await hederaKit();
  if (hedera) return hedera.kit.hederaFlowAsOf(checkpoint.chains?.[hedera.key], hedera.key, hedera.kit.flowSetHash(hedera.kit.hederaFlowAccounts(project)));
  const all = readCutoffMap(project);
  const reached = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, checkpoint.chains?.[c]?.lastBlock]));
  if (Object.keys(reached).length) return asOfFromReached(all, reached);
  const { solanaFlowChains } = await import("./lib/solana/flowConfig.js");
  return asOfFromSolanaScan(all, checkpoint.chains, solanaFlowChains(project.config).map((c) => c.key));
};

const main = async () => {
  const cexConfig = (await readOptionalJson(CEX_CONFIG_PATH)) ?? { wallets: [] };
  const cexSet = new Set(
    (cexConfig.wallets ?? [])
      .map((w) => (typeof w.address === "string" ? w.address.trim().toLowerCase() : null))
      .filter(Boolean),
  );
  console.log(`Loaded ${cexSet.size} CEX addresses.`);

  const dexConfig = (await readOptionalJson(DEX_CONFIG_PATH)) ?? { pools: [] };
  const dexSet = new Set(
    (dexConfig.pools ?? [])
      .map((p) => (typeof p.address === "string" ? p.address.trim().toLowerCase() : null))
      .filter(Boolean),
  );
  console.log(`Loaded ${dexSet.size} DEX pool addresses.`);

  let checkpoint = (await readOptionalJson(CHECKPOINT_PATH)) ?? { chains: {} };
  let history = (await readOptionalJson(HISTORY_PATH)) ?? { entries: [] };

  // Schema version: bump when the classification changes so old accumulated
  // history is recomputed from scratch instead of mixed with new fields.
  //   v2 = adds DEX swap flows (dexIn/dexOut/dexNet).
  // A pre-v2 file was scanned for CEX flows only, and the checkpoint already
  // advanced past those blocks — so DEX flows can't be backfilled by resuming.
  // Since CEX and DEX come from the SAME getLogs pass, the only correct way to
  // add DEX history is a fresh full re-scan (resuming would double-count CEX).
  const SCHEMA_VERSION = 3;
  // A Hedera project keeps its scan cursors in this same checkpoint file (scan-hedera-flows.js), and its
  // history is rebuilt from the day store, so a missing history must not wipe them.
  if ((history.schema ?? 1) < SCHEMA_VERSION && !projectHasVm(project.config, "hedera")) {
    console.log(`History schema ${history.schema ?? 1} < ${SCHEMA_VERSION}: resetting for a clean CEX+DEX backfill.`);
    history = { entries: [] };
    checkpoint = { chains: {} };
  }

  // Seed day buckets from existing history so we accumulate across runs.
  const dayBuckets = new Map();
  for (const e of history.entries ?? []) {
    dayBuckets.set(e.date, {
      in: e.in ?? 0,
      out: e.out ?? 0,
      dexIn: e.dexIn ?? 0,
      dexOut: e.dexOut ?? 0,
      chains: e.chains ?? {},
    });
  }

  if (Object.keys(CHAINS).length === 0) {
    // Solana-only projects have no eth_getLogs chains. Publish an empty
    // history so the exchange panel can show its empty state instead of
    // loading a 404. TEL's chain table is never empty.
    console.log(`No EVM chains for ${project.slug}; publishing Solana venue flows (empty until scan-solana-flows.js has run).`);
  }
  for (const chainKey of Object.keys(CHAINS)) {
    await scanChain(chainKey, cexSet, dexSet, checkpoint, dayBuckets);
  }

  // The final row is today's hours so far; flag it so the UI can label it
  // instead of drawing a collapse (see scripts/lib/partialDay.js).
  const entries = markPartialDay((Object.keys(CHAINS).length === 0 ? ((await solanaEntries()) ?? (await hederaEntries())) : null) ?? Array.from(dayBuckets.entries())
    .map(([date, b]) => ({
      date,
      chains: b.chains,
      in: Math.round(b.in),
      out: Math.round(b.out),
      net: Math.round(b.in - b.out),
      dexIn: Math.round(b.dexIn ?? 0),
      dexOut: Math.round(b.dexOut ?? 0),
      dexNet: Math.round((b.dexIn ?? 0) - (b.dexOut ?? 0)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date)));

  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify({ schema: SCHEMA_VERSION, generatedAt: new Date().toISOString(), asOf: await projectAsOf(checkpoint), entries }, null, 2)}\n`, "utf8");
  await fs.writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  console.log(`Wrote ${entries.length} daily flow entries → ${HISTORY_PATH}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
