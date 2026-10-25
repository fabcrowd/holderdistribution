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
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("scan-exchange-flows");

await loadEnv();

const HISTORY_PATH = path.resolve(process.cwd(), "public/data/exchange-flow-history.json");
const CHECKPOINT_PATH = path.resolve(process.cwd(), "public/data/exchange-flow-checkpoint.json");
const CEX_CONFIG_PATH = path.resolve(process.cwd(), "config/cex-wallets.json");
const DEX_CONFIG_PATH = path.resolve(process.cwd(), "config/dex-contracts.json");

const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TEL_DIVISOR = 100; // TEL has 2 decimals
// Sanity ceiling: a single TEL transfer cannot exceed total supply (~100B).
// Larger values are corrupt / non-standard logs and are skipped.
const MAX_SANE_TEL = 200e9;

// TEL token contract per chain + a default start block ≈ 1 year back, so the
// history covers the full 1Y timeframe (matching the tier-outflow scan) rather
// than only the recent months. Override via env to backfill deeper.
// Token addresses come from config/chains.json, never a literal here. Base was
// hardcoded to 0xc2106ca7… for months, which is NFTEarthOFT and not TEL, so the
// Base leg of this feed silently matched nothing and Base never appeared in the
// history at all. config/chains.json had the right address the whole time.
const CHAIN_CONFIG = JSON.parse(
  await fs.readFile(path.resolve(process.cwd(), "config/chains.json"), "utf8"),
);
const tokenFor = (chainKey) => {
  const token = CHAIN_CONFIG[chainKey]?.tokenAddress;
  if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/i.test(token)) {
    throw new Error(`config/chains.json is missing a valid tokenAddress for ${chainKey}`);
  }
  return token.toLowerCase();
};

const CHAINS = {
  ethereum: { token: tokenFor("ethereum"), chunk: 800, defaultStart: Number(process.env.FLOW_START_BLOCK_ETH ?? 22_800_000) },
  polygon: { token: tokenFor("polygon"), chunk: 1000, defaultStart: Number(process.env.FLOW_START_BLOCK_POLYGON ?? 74_400_000) },
  // 25_614_028 is TEL's first Transfer on Base (verified via Blockscout getLogs
  // from block 0). The previous 32_600_000 was picked for the wrong token.
  base: { token: tokenFor("base"), chunk: Number(process.env.FLOW_CHUNK_BASE ?? 1000), defaultStart: Number(process.env.FLOW_START_BLOCK_BASE ?? 25_614_028) },
};

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
  const rpcUrls = await getUsableRpcUrls(chainKey);
  if (rpcUrls.length === 0) {
    console.warn(`  ${chainKey}: no RPC URLs configured — skipping.`);
    return;
  }

  const latest = hexToNumber(await rpcCall(rpcUrls[0], "eth_blockNumber", []));
  const from = checkpoint.chains?.[chainKey]?.lastBlock != null
    ? checkpoint.chains[chainKey].lastBlock + 1
    : cfg.defaultStart;
  const end = Math.min(latest, from + MAX_BLOCKS_PER_RUN - 1);
  if (from > end) {
    console.log(`  ${chainKey}: up to date (block ${from - 1}).`);
    return;
  }

  // Piecewise block→timestamp model: sample real timestamps ~once per day of
  // blocks and interpolate within each segment. A single linear fit across
  // millions of blocks drifts by days (block time isn't constant); piecewise
  // sampling bounds the error to intra-day so each transfer gets the right date.
  const roughSecPerBlock = 2;
  const sampleStep = Math.max(1, Math.floor(86400 / roughSecPerBlock)); // ~1 day of blocks
  const sampleBlocks = [];
  for (let b = from; b < end; b += sampleStep) sampleBlocks.push(b);
  sampleBlocks.push(end);
  const sampleTs = await Promise.all(
    sampleBlocks.map((b, i) => blockTimestampSec(rpcUrls[i % rpcUrls.length], b)),
  );
  const samples = sampleBlocks
    .map((b, i) => ({ block: b, ts: sampleTs[i] }))
    .filter((s) => s.ts != null);
  const dateOf = (block) => {
    if (samples.length === 0) return new Date(0).toISOString().slice(0, 10);
    // find bracketing samples (samples are ascending in block)
    let lo = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].block <= block) lo = i;
      else break;
    }
    const a = samples[lo];
    const b = samples[Math.min(lo + 1, samples.length - 1)];
    const span = b.block - a.block;
    const ts = span > 0 ? a.ts + ((block - a.block) / span) * (b.ts - a.ts) : a.ts;
    return new Date(ts * 1000).toISOString().slice(0, 10);
  };

  console.log(`  ${chainKey}: scanning ${from}..${end} (latest ${latest}) across ${rpcUrls.length} keys`);

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
        getLogs(rpcUrls[j % rpcUrls.length], {
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${stop.toString(16)}`,
          address: cfg.token,
          topics: [TRANSFER_TOPIC0],
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
        const value = Number(BigInt(log.data ?? "0x0")) / TEL_DIVISOR;
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

const main = async () => {
  const cexConfig = JSON.parse(await fs.readFile(CEX_CONFIG_PATH, "utf8"));
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
  if ((history.schema ?? 1) < SCHEMA_VERSION) {
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

  for (const chainKey of Object.keys(CHAINS)) {
    await scanChain(chainKey, cexSet, dexSet, checkpoint, dayBuckets);
  }

  const entries = Array.from(dayBuckets.entries())
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
    .sort((a, b) => a.date.localeCompare(b.date));

  await fs.writeFile(HISTORY_PATH, `${JSON.stringify({ schema: SCHEMA_VERSION, generatedAt: new Date().toISOString(), entries }, null, 2)}\n`, "utf8");
  await fs.writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  console.log(`Wrote ${entries.length} daily flow entries → ${HISTORY_PATH}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
