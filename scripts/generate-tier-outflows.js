#!/usr/bin/env node
/**
 * generate-tier-outflows.js
 *
 * Per-tier "where did the outflow go" attribution for the distribution
 * tier-flow hover. For every retail wallet, this traces its OUTGOING TEL
 * transfers and classifies each by destination:
 *
 *   to ∈ DEX pool   → SOLD on-chain (dexSwap) OR added LP (dexLp); `dex` = sum
 *   to ∈ CEX wallet → sent to an EXCHANGE (deposit)     (cex)
 *   otherwise       → MOVED to another wallet (split / self-custody / gift) (moved)
 *
 * Each transfer is attributed to the sender's balance TIER at the time (from
 * the nearest holder snapshot on/before the transfer date) and bucketed by
 * calendar day. The servable output then rolls the last N days into 7/30/90-day
 * windows, so the hover can say: "over this window, wallets in tier X sold
 * A TEL on a DEX, sent B to exchanges, and moved C to other wallets."
 *
 * Incremental & resumable, exactly like scan-exchange-flows.js: each run scans
 * up to MAX_BLOCKS_PER_RUN new blocks per chain from a checkpoint and appends
 * to the per-day store, so once the initial backfill is caught up a daily run
 * only scans the newest ~day of blocks. Old days age out of the windows.
 *
 * Symmetrically, for every retail wallet's INCOMING transfer, the sender is
 * classified so a tier's growth can be explained too:
 *
 *   from ∈ DEX pool   → BOUGHT (dexSwap) OR unstaked from LP (dexLp); `dex` = sum
 *   from ∈ CEX wallet → WITHDRAWN from an exchange (was custodied) (cex)
 *   otherwise         → RECEIVED from another wallet (organic accumulation / consolidation) (wallet)
 *
 * attributed to the RECEIVER's tier at the time, so the hover can also say:
 * "over this window, wallets in tier X bought A TEL on a DEX, withdrew B from
 * exchanges, and received C from other wallets."
 *
 * Output:
 *   public/data/tier-outflows.json          (servable — small, ranges only)
 *     { schema, generatedAt, latestDate, complete, ranges: {
 *         "<days>": { from, to, tiers: { "<tier>": {
 *           dex, cex, moved, inflows: { dex, cex, wallet }, byChain } } } } }
 *   data/tier-outflows-days.json            (accumulation store — NOT served;
 *     the 371-day per-day bucket history a browser never reads. Committed so
 *     the next run can seed from it; kept out of public/ so it isn't shipped
 *     to every visitor — it was 97.8% of the old servable file's bytes.)
 *   data/tier-outflows-checkpoint.json      { chains: { <chain>: { lastBlock } } }
 *     (also moved out of public/ — a scan-progress cursor, not chart data.)
 *
 * Reads retail balances/tiers from the committed history of tel-holders.json +
 * funding-wallets.json via git; reads Transfer logs via decrypted Alchemy RPCs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getUsableRpcUrls, getLogs, rpcCall } from "./lib/rpc.js";
import { reconcileParts } from "./lib/reconcileParts.js";
import { coverageFor, firstAttributedDate } from "./lib/attributionCoverage.js";
import { classifyReceiptLogs, dexSubClass, LP_EVENT_TOPICS } from "./lib/dexTransferClass.js";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectPaths, projectChains, projectWork, projectClassificationPath } from "./lib/projects.js";
import { resolveStakeChangedTarget } from "./lib/stakerTarget.js";
import { projectHolderTiers, rangeLabelOf } from "./lib/holderTiers.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: the project's
// data dir (on disk + git history), work dir (day store / checkpoint), chain
// map, classification lists and StakeChanged staking contract. TEL resolves to
// exactly the paths/addresses this script used to hardcode.
const project = selectPipelineProject("generate-tier-outflows", { ported: true });
const IS_LEGACY = project.config?.data?.legacyRoot === true;
const data = projectPaths(project);
const work = projectWork(project);

// How DEX transfers are split into swap vs LP: "receipts" (default, one receipt
// per DEX tx) or "logs" (bulk LP-event getLogs per chunk; for long backfills).
const DEX_CLASSIFY_MODE = (process.env.TIER_DEX_CLASSIFY ?? "receipts").toLowerCase();

await loadEnv();

const OUT_PATH = data("tier-outflows.json");
const DAYS_STORE_PATH = work("tier-outflows-days.json");
const CHECKPOINT_PATH = work("tier-outflows-checkpoint.json");
// Old locations from before the v10 file split — a v9 store still has `days`
// embedded directly in OUT_PATH, and its checkpoint sat in public/. Read once
// so the first v10 run migrates seamlessly instead of re-scanning from
// scratch; every run after that reads/writes only the new paths above.
const LEGACY_CHECKPOINT_PATH = data("tier-outflows-checkpoint.json");
// TEL: the config/ root files. Another project: its own `classification.*`
// (null = none declared = empty list, never TEL's).
const EXCLUSIONS_PATH = projectClassificationPath(project, "exclusions");
const CEX_CONFIG_PATH = projectClassificationPath(project, "cexWallets");
const DEX_CONFIG_PATH = projectClassificationPath(project, "dexContracts");
// Repo-relative snapshot paths for git-history reads (TEL: public/data/<file>).
const SNAP_REL = data.rel("tel-holders.json");
const FUND_REL = data.rel("funding-wallets.json");

const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Per-chain divisor = 10 ** decimals from the chain map (TEL: 2 decimals -> 100).
// Sanity ceiling: a single transfer cannot exceed total supply (TEL ~100B).
// Anything larger is a corrupt / non-standard log value and is skipped so it
// can't poison the aggregates.
const MAX_SANE_TEL = 2 * (Number(project.config?.supply?.target) || 100e9);
// Staking a wallet's own TEL (deposit to this contract) or unstaking (a
// withdrawal from it) doesn't change that wallet's tier-qualifying balance —
// makeTierResolver already adds staked amount back into the SAME wallet's
// total, so a stake/unstake is an internal reallocation, not a real gain or
// loss. Neither cexSet nor dexSet contains this address, so without this
// check a stake was being classified as a generic "moved" outflow and an
// unstake as a generic "wallet" inflow — inflating both "Left tier" and
// "Bought in" by amounts that never actually left or arrived, which is why
// those two figures could net to a different (even opposite-signed) result
// than the tier's real snapshot-to-snapshot balance change.
// TEL: 0x92e43aec69207755cb1e6a8dc589aae630476330 (the `kind: "stakeChanged"`
// entry in config/projects/tel.json). A project without one gets null, which
// never equals an address, so nothing is special-cased.
const STAKING_CONTRACT = resolveStakeChangedTarget(project)?.contract ?? null;
const SCHEMA_VERSION = 9; // v9 = staking contract transfers no longer misclassified as generic moved/wallet flows

// Fixed rolling windows (days), matching the page's timeframe selector
// (1D/7D/30D/90D/1Y). YTD is derived separately from the calendar year.
const WINDOWS = [1, 7, 30, 90, 365];
const MAX_WINDOW_DAYS = Math.max(...WINDOWS);
const KEEP_DAYS = MAX_WINDOW_DAYS + 6; // prune older day buckets
// `??` only falls back on null/undefined — GitHub Actions sets this env var to
// an EMPTY STRING (not unset) on schedule-triggered runs, since
// `github.event.inputs.*` is only populated for workflow_dispatch. That made
// `Number("" ?? 3_000_000)` evaluate to `Number("")` = 0, silently turning
// every cron run into a scan-nothing no-op (see `if (from > end) return` in
// scanChain below) while manual runs looked fine. `||` treats "" as falsy too,
// so it now falls back correctly regardless of trigger type.
const MAX_BLOCKS_PER_RUN = Number(process.env.MAX_BLOCKS_PER_RUN) || 3_000_000;

// Token addresses come from the project's chain map (TEL: config/chains.json)
// — see the note in scan-exchange-flows.js. Base was hardcoded to NFTEarthOFT, not TEL.
const CHAIN_CONFIG = projectChains(project);
const tokenFor = (chainKey) => {
  const token = CHAIN_CONFIG[chainKey]?.tokenAddress;
  if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/i.test(token)) {
    throw new Error(`project ${project.slug}: chain map is missing a valid tokenAddress for ${chainKey}`);
  }
  return token.toLowerCase();
};
const divisorFor = (chainKey) => {
  const d = Number(CHAIN_CONFIG[chainKey]?.decimals ?? CHAIN_CONFIG[chainKey]?.tokens?.legacy?.decimals);
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error(`project ${project.slug}: no valid decimals for ${chainKey}`);
  return 10 ** d;
};

// Known chains keep their tuned chunk / blocks-per-day; any other chain a
// project maps uses its `blocksPerDay` from config/projects/<slug>.json
// (chains[]) or a 2-second-block default.
const CHAIN_TUNING = {
  ethereum: { chunk: 800, blocksPerDay: 7150 },
  polygon: { chunk: 1000, blocksPerDay: 43000 },
  base: { chunk: 1000, blocksPerDay: 43000 },
};
const chainEntry = (chainKey) => {
  const tuned = CHAIN_TUNING[chainKey];
  const declared = Number((project.config?.chains ?? []).find((c) => c.key === chainKey)?.blocksPerDay);
  return {
    token: tokenFor(chainKey),
    chunk: Number(process.env[`FLOW_CHUNK_${chainKey.toUpperCase()}`] ?? tuned?.chunk ?? 1000),
    blocksPerDay: tuned?.blocksPerDay ?? (Number.isFinite(declared) && declared > 0 ? declared : 43200),
    divisor: divisorFor(chainKey),
  };
};
// TEL: exactly ethereum, polygon, base (unchanged table + divisor 100).
const CHAINS = IS_LEGACY
  ? { ethereum: chainEntry("ethereum"), polygon: chainEntry("polygon"), base: chainEntry("base") }
  : Object.fromEntries(Object.keys(CHAIN_CONFIG).map((k) => [k, chainEntry(k)]));

// The project's distribution tiers (TEL: the historical 10, unchanged).
const TIERS = projectHolderTiers(project).distributionTiers;
const tierOf = (v) => rangeLabelOf(TIERS, v);

const git = (a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const showJson = (commit, file) => JSON.parse(git(["show", `${commit}:${file}`]));
const commitsByDate = (file) => {
  const out = git(["log", "--format=%H %ad", "--date=short", "--", file]);
  const map = new Map();
  for (const line of out.trim().split("\n")) {
    const [h, d] = line.split(" ");
    if (h && d && !map.has(d)) map.set(d, h);
  }
  return map;
};

const readOptionalJson = async (p) => {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
};

// `inflowsBySourceTier`/`movedByDestTier`/`dexSwap`/`dexLp` are purely-additive
// fields — old day buckets simply lack them until rescanned, so SCHEMA_VERSION
// stays at 9 (a bump would discard the entire multi-hour backfill). `dex` remains
// the sum of dexSwap+dexLp for backward-compatible UI consumers.
const emptyTierBucket = () => ({
  dex: 0, dexSwap: 0, dexLp: 0, cex: 0, moved: 0,
  splitWallets: 0, splitEvents: 0, splitTel: 0, byExchange: {},
  inflows: { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 },
  byChain: {}, inflowsBySourceTier: {}, movedByDestTier: {},
});
const emptyChainLeg = () => ({
  dex: 0, dexSwap: 0, dexLp: 0, cex: 0, moved: 0,
  inflows: { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 },
});

/** Resolve a DEX transfer's sub-class via receipt co-events (cached per tx). */
const resolveDexSub = async (ctx, rpcUrl, txHash) => {
  const key = (txHash ?? "").toLowerCase();
  if (!key) return "dexSwap";
  if (ctx.dexTxClass.has(key)) return ctx.dexTxClass.get(key);
  let sub = "dexSwap";
  try {
    const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [key]);
    sub = dexSubClass(classifyReceiptLogs(receipt?.logs ?? []));
  } catch {
    sub = "dexSwap";
  }
  ctx.dexTxClass.set(key, sub);
  return sub;
};

const topicToAddress = (t) =>
  typeof t === "string" && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null;
const hexToNumber = (h) => parseInt(h, 16);
const dayBefore = (dateStr, days) =>
  new Date(Date.parse(dateStr) - days * 86400000).toISOString().slice(0, 10);

const blockTimestampSec = async (rpcUrl, block) => {
  const b = await rpcCall(rpcUrl, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
  return b?.timestamp ? hexToNumber(b.timestamp) : null;
};

// Lazily builds & caches the retail addr→tier map from the nearest holder
// snapshot on/before a given date (combined balance across chains + staking,
// excluding CEX/DEX/excluded addresses).
const makeTierResolver = (snapCommits, fundCommits, snapDates, fundDates, excl) => {
  const cache = new Map();
  const nearest = (dates, target) => {
    let best = null;
    for (const d of dates) { if (d <= target) best = d; else break; }
    return best ?? dates[0];
  };
  const buildFor = (snapDate) => {
    // Some old snapshot blobs are malformed / non-JSON; a caller catches the
    // throw and falls back to the next valid snapshot rather than crashing.
    const snap = showJson(snapCommits.get(snapDate), SNAP_REL);
    let fund = { wallets: [] };
    const fd = fundDates.length ? nearest(fundDates, snapDate) : null;
    if (fd) { try { fund = showJson(fundCommits.get(fd), FUND_REL); } catch { /* skip bad funding snapshot */ } }
    const bal = new Map();
    for (const chain of Object.values(snap.chains ?? {})) {
      for (const h of chain.holders ?? []) {
        const a = (h.address ?? "").trim().toLowerCase();
        if (!a || excl.has(a)) continue;
        bal.set(a, (bal.get(a) ?? 0) + Number(h.balance ?? 0));
      }
    }
    for (const w of fund.wallets ?? []) {
      const a = (w.fundingWallet ?? "").trim().toLowerCase();
      const s = Number(w.stakedAmount ?? 0);
      if (!a || s <= 0 || excl.has(a)) continue;
      bal.set(a, (bal.get(a) ?? 0) + s);
    }
    const tiers = new Map();
    for (const [a, v] of bal) { const t = tierOf(v); if (t) tiers.set(a, t); }
    return tiers;
  };
  const EMPTY = new Map();
  return (date) => {
    // Start at the nearest snapshot on/before `date`, walking to older
    // snapshots if one fails to parse. If all older ones fail, try newer.
    let idx = snapDates.length - 1;
    while (idx >= 0 && snapDates[idx] > date) idx--;
    if (idx < 0) idx = 0;
    for (let i = idx; i >= 0; i--) {
      const sd = snapDates[i];
      if (cache.has(sd)) { if (cache.get(sd)) return cache.get(sd); continue; }
      try { const m = buildFor(sd); cache.set(sd, m); return m; }
      catch (e) { cache.set(sd, null); console.warn(`  tier map ${sd} unparseable (${e.message}); falling back.`); }
    }
    for (let i = idx + 1; i < snapDates.length; i++) {
      const sd = snapDates[i];
      if (cache.has(sd)) { if (cache.get(sd)) return cache.get(sd); continue; }
      try { const m = buildFor(sd); cache.set(sd, m); return m; }
      catch (e) { cache.set(sd, null); }
    }
    return EMPTY;
  };
};

const scanChain = async (chainKey, ctx, checkpoint, dayBuckets) => {
  const cfg = CHAINS[chainKey];
  const rpcUrls = await getUsableRpcUrls(chainKey);
  if (rpcUrls.length === 0) { console.warn(`  ${chainKey}: no RPC URLs — skipping.`); return; }

  const latest = hexToNumber(await rpcCall(rpcUrls[0], "eth_blockNumber", []));
  const defaultStart = Math.max(0, latest - Math.ceil(cfg.blocksPerDay * (MAX_WINDOW_DAYS + 3)));
  const from = checkpoint.chains?.[chainKey]?.lastBlock != null
    ? checkpoint.chains[chainKey].lastBlock + 1
    : defaultStart;
  const end = Math.min(latest, from + MAX_BLOCKS_PER_RUN - 1);
  // Recorded on every run (even when nothing to scan) so `complete` can be
  // computed in main() without re-fetching the tip: "caught up" means the
  // checkpoint's lastBlock is within a day of blocks of this recorded tip.
  checkpoint.chains = checkpoint.chains ?? {};
  checkpoint.chains[chainKey] = { ...(checkpoint.chains[chainKey] ?? {}), latest };
  if (from > end) { console.log(`  ${chainKey}: up to date (block ${from - 1}).`); return; }

  // Piecewise block→timestamp sampling (~1 day of blocks per sample).
  const sampleStep = Math.max(1, cfg.blocksPerDay);
  const sampleBlocks = [];
  for (let b = from; b < end; b += sampleStep) sampleBlocks.push(b);
  sampleBlocks.push(end);
  const sampleTs = await Promise.all(
    sampleBlocks.map((b, i) => blockTimestampSec(rpcUrls[i % rpcUrls.length], b)),
  );
  const samples = sampleBlocks.map((b, i) => ({ block: b, ts: sampleTs[i] })).filter((s) => s.ts != null);
  const dateOf = (block) => {
    if (samples.length === 0) return new Date(0).toISOString().slice(0, 10);
    let lo = 0;
    for (let i = 1; i < samples.length; i++) { if (samples[i].block <= block) lo = i; else break; }
    const a = samples[lo];
    const b = samples[Math.min(lo + 1, samples.length - 1)];
    const span = b.block - a.block;
    const ts = span > 0 ? a.ts + ((block - a.block) / span) * (b.ts - a.ts) : a.ts;
    return new Date(ts * 1000).toISOString().slice(0, 10);
  };

  console.log(`  ${chainKey}: scanning ${from}..${end} (latest ${latest}) across ${rpcUrls.length} keys`);

  const chunks = [];
  for (let s = from; s <= end; s += cfg.chunk) chunks.push([s, Math.min(s + cfg.chunk - 1, end)]);
  const conc = Math.min(rpcUrls.length, 8);
  let lastGood = from - 1;
  let matched = 0;
  let aborted = false;

  for (let i = 0; i < chunks.length && !aborted; i += conc) {
    const batch = chunks.slice(i, i + conc);
    const results = await Promise.allSettled(
      batch.map(([s, e], j) =>
        getLogs(rpcUrls[j % rpcUrls.length], {
          fromBlock: `0x${s.toString(16)}`,
          toBlock: `0x${e.toString(16)}`,
          address: cfg.token,
          topics: [TRANSFER_TOPIC0],
        }),
      ),
    );
    // Pre-classify this batch's DEX transfers before the per-log loop below,
    // which awaits resolveDexSub() one transfer at a time — on a cold
    // full-year scan that was tens of thousands (Polygon: millions) of strictly
    // sequential receipt round-trips.
    //   TIER_DEX_CLASSIFY=logs: one eth_getLogs per chunk for LP events
    //     (Balancer PoolBalanceChanged, Uniswap/QuickSwap Mint/Burn) emitted by
    //     the configured DEX addresses; a DEX tx with one is dexLp, else dexSwap.
    //     Same rule as classifyReceiptLogs, restricted to LP events on the DEX
    //     contracts themselves. A failed chunk falls back to receipts.
    //   default (receipts): receipts fetched in parallel across the RPC pool.
    const dexTxsByChunk = batch.map(() => new Set());
    results.forEach((r, j) => {
      if (r.status !== "fulfilled") return;
      for (const log of r.value) {
        const a = topicToAddress(log.topics?.[1]);
        const b = topicToAddress(log.topics?.[2]);
        const tx = typeof log.transactionHash === "string" ? log.transactionHash.toLowerCase() : null;
        if (tx && !ctx.dexTxClass.has(tx) && ((a && ctx.dexSet.has(a)) || (b && ctx.dexSet.has(b)))) dexTxsByChunk[j].add(tx);
      }
    });
    const needReceipts = [];
    if (DEX_CLASSIFY_MODE === "logs") {
      await Promise.all(batch.map(async ([s, e], j) => {
        if (dexTxsByChunk[j].size === 0) return;
        try {
          const lpLogs = await getLogs(rpcUrls[j % rpcUrls.length], {
            fromBlock: `0x${s.toString(16)}`,
            toBlock: `0x${e.toString(16)}`,
            address: [...ctx.dexSet],
            topics: [LP_EVENT_TOPICS],
          });
          const lpTxs = new Set(lpLogs.map((l) => String(l.transactionHash ?? "").toLowerCase()));
          for (const tx of dexTxsByChunk[j]) ctx.dexTxClass.set(tx, lpTxs.has(tx) ? "dexLp" : "dexSwap");
        } catch {
          needReceipts.push(...dexTxsByChunk[j]);
        }
      }));
    } else {
      for (const set of dexTxsByChunk) needReceipts.push(...set);
    }
    const receiptConc = Math.max(1, Math.min(Number(process.env.TIER_RECEIPT_CONCURRENCY) || rpcUrls.length * 2, 16));
    for (let k = 0; k < needReceipts.length; k += receiptConc) {
      await Promise.all(
        needReceipts.slice(k, k + receiptConc).map((tx, n) => resolveDexSub(ctx, rpcUrls[n % rpcUrls.length], tx)),
      );
    }
    if ((i / conc) % 10 === 0) {
      console.log(`    ${chainKey}: batch ${i / conc + 1}/${Math.ceil(chunks.length / conc)} (block ${batch[0][0]}, ${matched} legs, ${ctx.dexTxClass.size} DEX txs classified)`);
    }
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status !== "fulfilled") {
        console.warn(`    ${chainKey} ${batch[j][0]}-${batch[j][1]}: ${r.reason?.message ?? "getLogs failed"}; stopping at ${lastGood}.`);
        aborted = true;
        break;
      }
      const rpcForReceipt = rpcUrls[j % rpcUrls.length];
      for (const log of r.value) {
        const fromAddr = topicToAddress(log.topics?.[1]);
        if (!fromAddr) continue;
        const toAddr = topicToAddress(log.topics?.[2]);
        // A self-transfer (from === to, seen from some contract hook/approval
        // patterns) moves no value between wallets — counting it as both an
        // outflow and an inflow would double-book a net-zero event, inflating
        // both "moved out" and "received" for the same tier/day.
        if (toAddr && toAddr === fromAddr) continue;
        const value = Number(BigInt(log.data ?? "0x0")) / cfg.divisor;
        if (!Number.isFinite(value) || value <= 0 || value > MAX_SANE_TEL) continue;
        const date = dateOf(Number(log.blockNumber ? hexToNumber(log.blockNumber) : batch[j][0]));
        const tierMap = ctx.tierAt(date);
        const tier = tierMap.get(fromAddr);
        const txHash = typeof log.transactionHash === "string" ? log.transactionHash : null;
        // Resolve DEX sub-class once per transfer when either leg touches a
        // known pool/router — receipt fetch is cached by tx hash on ctx.
        let outDexSub = null;
        let inDexSub = null;
        if (toAddr && ctx.dexSet.has(toAddr)) {
          outDexSub = await resolveDexSub(ctx, rpcForReceipt, txHash);
        }
        if (fromAddr && ctx.dexSet.has(fromAddr)) {
          // Same tx → same receipt classification; reuse when both legs are DEX.
          inDexSub = outDexSub ?? await resolveDexSub(ctx, rpcForReceipt, txHash);
        }
        // A stake deposit isn't a real outflow — the wallet's tier-qualifying
        // balance already counts staked TEL, so this is money moving from
        // "liquid" to "staked" within the same wallet's total, not to
        // anywhere else. Classifying it as generic "moved" inflated "Left
        // tier" by amounts the tier never actually lost.
        if (tier && toAddr !== STAKING_CONTRACT) {
          let cls;
          if (toAddr && ctx.cexSet.has(toAddr)) cls = "cex";
          else if (outDexSub) cls = "dex";
          else cls = "moved";
          const day = dayBuckets.get(date) ?? {};
          const t = day[tier] ?? emptyTierBucket();
          t[cls] += value;
          if (cls === "dex" && outDexSub) {
            t[outDexSub] = (t[outDexSub] ?? 0) + value;
          }
          // Attribute exchange deposits to the receiving exchange by name.
          if (cls === "cex") {
            const name = ctx.cexName.get(toAddr) ?? "Unknown";
            t.byExchange = t.byExchange ?? {};
            t.byExchange[name] = (t.byExchange[name] ?? 0) + value;
          }
          // Per-chain breakdown (sparse — a chain only appears once it has a
          // non-zero contribution), so the UI's chain filter can narrow the
          // flow lines without a second data source.
          t.byChain = t.byChain ?? {};
          const chainLeg = (t.byChain[chainKey] ??= emptyChainLeg());
          chainLeg[cls] += value;
          if (cls === "dex" && outDexSub) {
            chainLeg[outDexSub] = (chainLeg[outDexSub] ?? 0) + value;
          }
          // Symmetric to inflowsBySourceTier below: attribute a "moved"
          // outflow by the DESTINATION wallet's tier, so a tier's outbound
          // moves can be split by where they landed. Additive-by-design (see
          // emptyTierBucket comment) — no SCHEMA_VERSION bump needed.
          if (cls === "moved") {
            const destTier = tierMap.get(toAddr) ?? "untracked";
            t.movedByDestTier = t.movedByDestTier ?? {};
            t.movedByDestTier[destTier] = (t.movedByDestTier[destTier] ?? 0) + value;
          }
          day[tier] = t;
          dayBuckets.set(date, day);
          matched++;
          // Fan-out tracking: distinct wallet recipients per (day, sender). A
          // sender that moves TEL to >=2 distinct wallets on a day is a "split"
          // (fragmenting its position). Only wallet-to-wallet moves count — not
          // exchange deposits or DEX sells. Folded into day buckets in main().
          if (cls === "moved" && toAddr) {
            const key = `${date}|${fromAddr}`;
            let fo = ctx.fanout.get(key);
            if (!fo) { fo = { tier, dests: new Set(), tel: 0 }; ctx.fanout.set(key, fo); }
            fo.dests.add(toAddr);
            fo.tel += value;
          }
        }
        // Symmetric inflow attribution: classify why the RECEIVER's tier grew,
        // by the sender's identity — a DEX pool means an on-chain buy OR an
        // LP withdrawal (unstake from pool), a CEX wallet means a withdrawal
        // (still accumulation), anything else means TEL simply moved in from
        // another wallet. An unstake withdrawal isn't a real inflow for the
        // same reason a stake deposit isn't a real outflow — skip it.
        if (toAddr && fromAddr !== STAKING_CONTRACT) {
          const toTier = tierMap.get(toAddr);
          if (toTier) {
            let icls;
            if (inDexSub) icls = "dex";
            else if (ctx.cexSet.has(fromAddr)) icls = "cex";
            else icls = "wallet";
            const day = dayBuckets.get(date) ?? {};
            const t = day[toTier] ?? emptyTierBucket();
            t.inflows = t.inflows ?? { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 };
            t.inflows[icls] += value;
            if (icls === "dex" && inDexSub) {
              t.inflows[inDexSub] = (t.inflows[inDexSub] ?? 0) + value;
            }
            t.byChain = t.byChain ?? {};
            const chainLeg = (t.byChain[chainKey] ??= emptyChainLeg());
            chainLeg.inflows[icls] += value;
            if (icls === "dex" && inDexSub) {
              chainLeg.inflows[inDexSub] = (chainLeg.inflows[inDexSub] ?? 0) + value;
            }
            // Symmetric to movedByDestTier above: attribute a "wallet" inflow
            // by the SENDER's tier, so sum(inflowsBySourceTier) always equals
            // inflows.wallet. Additive-by-design — no SCHEMA_VERSION bump.
            if (icls === "wallet") {
              const fromTier = tierMap.get(fromAddr) ?? "untracked";
              t.inflowsBySourceTier = t.inflowsBySourceTier ?? {};
              t.inflowsBySourceTier[fromTier] = (t.inflowsBySourceTier[fromTier] ?? 0) + value;
            }
            day[toTier] = t;
            dayBuckets.set(date, day);
          }
        }
      }
      lastGood = batch[j][1];
    }
  }

  checkpoint.chains[chainKey] = { ...checkpoint.chains[chainKey], lastBlock: lastGood };
  console.log(`  ${chainKey}: advanced to ${lastGood} (${matched} attributed outflow legs)`);
};

const main = async () => {
  const ex = EXCLUSIONS_PATH ? JSON.parse(await fs.readFile(EXCLUSIONS_PATH, "utf8")) : {};
  const excl = new Set();
  for (const a of ex.addresses ?? []) {
    const s = (typeof a === "string" ? a : a?.address)?.trim().toLowerCase();
    if (s) excl.add(s);
  }
  // Also honor per-chain exclusions (config.chains.<chain>.addresses) — this
  // used to be skipped here even though generate-holders-lite.js reads them,
  // which would silently make a wallet "retail" in the tier-flow numbers
  // while the distribution table already excluded it, the moment anyone
  // populates a per-chain entry (currently all empty, so dormant today).
  for (const chainInfo of Object.values(ex.chains ?? {})) {
    for (const a of chainInfo?.addresses ?? []) {
      const s = (typeof a === "string" ? a : a?.address)?.trim().toLowerCase();
      if (s) excl.add(s);
    }
  }
  const cexConfig = CEX_CONFIG_PATH ? JSON.parse(await fs.readFile(CEX_CONFIG_PATH, "utf8")) : { wallets: [] };
  const cexSet = new Set();
  // address -> exchange name, so an outflow can be attributed to the exchange
  // that actually received it (config stores the name in `label`).
  const cexName = new Map();
  for (const w of cexConfig.wallets ?? []) if (typeof w.address === "string") {
    const a = w.address.trim().toLowerCase();
    cexSet.add(a); excl.add(a);
    const n = (w.label ?? w.exchange ?? w.walletName ?? "").toString().trim();
    if (n) cexName.set(a, n);
  }
  const dexConfig = (DEX_CONFIG_PATH ? await readOptionalJson(DEX_CONFIG_PATH) : null) ?? { pools: [] };
  const dexSet = new Set();
  for (const p of dexConfig.pools ?? []) if (typeof p.address === "string") { const a = p.address.trim().toLowerCase(); dexSet.add(a); excl.add(a); }
  for (const r of dexConfig.routers ?? []) if (typeof r.address === "string") { const a = r.address.trim().toLowerCase(); dexSet.add(a); excl.add(a); }
  console.log(`Loaded ${cexSet.size} CEX, ${dexSet.size} DEX addresses.`);

  const snapCommits = commitsByDate(SNAP_REL);
  const fundCommits = commitsByDate(FUND_REL);
  const snapDates = [...snapCommits.keys()].sort();
  const fundDates = [...fundCommits.keys()].sort();
  if (snapDates.length === 0) { console.warn("No snapshots."); return; }

  const tierAt = makeTierResolver(snapCommits, fundCommits, snapDates, fundDates, excl);
  // fanout: (date|sender) -> { tier, dests:Set, tel } for this run's scanned
  // transfers. Only spans the blocks scanned this run; a day is scanned within
  // one run (checkpoint advances forward), so per-day fan-out is complete.
  // dexTxClass: txHash → "dexSwap"|"dexLp" cache for receipt co-event lookups
  // within this run (and across chains in the same process).
  const ctx = { cexSet, cexName, dexSet, tierAt, fanout: new Map(), dexTxClass: new Map() };

  // Checkpoint: new location first, falling back once to the pre-split
  // public/ location so an in-progress backfill's block progress carries
  // over rather than restarting (Polygon/Base were ~163 days into a ~370-day
  // catch-up at the time of this split — losing that would waste ~5 runs).
  let checkpoint = (await readOptionalJson(CHECKPOINT_PATH))
    ?? (await readOptionalJson(LEGACY_CHECKPOINT_PATH))
    ?? { chains: {} };
  // Day-bucket store: new location first, falling back to `days` embedded in
  // the old servable file (pre-split, that file WAS the store).
  let existing = (await readOptionalJson(DAYS_STORE_PATH))
    ?? (await readOptionalJson(OUT_PATH))
    ?? { schema: SCHEMA_VERSION, days: [] };
  // Reset only if the store predates the per-day model (v1 pinned as-of) —
  // NOT on every version bump. A schema reset discards the entire backfill
  // and forces ~5 more multi-hour runs per chain, so only bump SCHEMA_VERSION
  // for changes that genuinely invalidate previously-scanned data (e.g. the
  // v9 staking-exclusion fix, which changed what counted as a real transfer).
  // Purely additive fields (byChain, complete, split-field rename) do not
  // need a reset — old day buckets simply lack the new field until rescanned.
  if ((existing.schema ?? 1) < SCHEMA_VERSION) {
    console.log(`Output schema ${existing.schema ?? 1} < ${SCHEMA_VERSION}: resetting for the per-day store.`);
    existing = { days: [] };
    checkpoint = { chains: {} };
  }

  // Seed per-day buckets from the existing store so we accumulate across runs.
  const dayBuckets = new Map();
  for (const d of existing.days ?? []) dayBuckets.set(d.date, { ...(d.tiers ?? {}) });

  for (const chainKey of Object.keys(CHAINS)) {
    await scanChain(chainKey, ctx, checkpoint, dayBuckets);
  }

  // Fold this run's fan-out into split counts: a sender that moved TEL to >=2
  // distinct wallets on a day is one split EVENT for its tier that day.
  // `splitWallets` sums the actual distinct destination wallets across all
  // such events (fo.dests.size), NOT the event count — it used to add a flat
  // +1 per event regardless of how many wallets were involved, so a sender
  // splitting to 2 wallets and one splitting to 50 both only counted as "1
  // wallet". `splitEvents` separately tracks how many distinct (day, sender)
  // fan-outs contributed, since a UI reader needs both numbers: how many
  // wallets TEL ended up in, and over how many separate occurrences.
  let splitEventsLogged = 0;
  for (const [key, fo] of ctx.fanout) {
    if (fo.dests.size < 2) continue;
    const date = key.slice(0, key.indexOf("|"));
    const day = dayBuckets.get(date) ?? {};
    const t = day[fo.tier] ?? emptyTierBucket();
    t.splitWallets = (t.splitWallets ?? 0) + fo.dests.size;
    t.splitEvents = (t.splitEvents ?? 0) + 1;
    t.splitTel = (t.splitTel ?? 0) + fo.tel;
    day[fo.tier] = t;
    dayBuckets.set(date, day);
    splitEventsLogged++;
  }
  console.log(`Fan-out: ${splitEventsLogged} split events (senders to >=2 wallets in a day).`);

  // Prune ancient days, then sort.
  const allDates = [...dayBuckets.keys()].sort();
  const scannedLatest = allDates[allDates.length - 1];
  // No EVM chains (Solana-only): scanChain never runs, so there are no day
  // buckets. Still publish every window, including ytd, dated today with
  // empty tiers. The UI then shows an empty state (or wallet moves from
  // holder-transitions) instead of a missing-file skeleton. TEL always has
  // EVM chains, so a TEL run that scanned nothing yet keeps latestDate unset.
  const latestDate = scannedLatest ?? (Object.keys(CHAINS).length === 0 ? new Date().toISOString().slice(0, 10) : undefined);
  if (latestDate) {
    const cutoff = dayBefore(latestDate, KEEP_DAYS);
    for (const d of allDates) if (d < cutoff) dayBuckets.delete(d);
  }
  const days = [...dayBuckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, tiers]) => {
      const rounded = {};
      for (const [tier, v] of Object.entries(tiers)) {
        const byExchange = {};
        for (const [n, amt] of Object.entries(v.byExchange ?? {})) byExchange[n] = Math.round(amt);
        const inf = v.inflows ?? { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 };
        const movedRounded = Math.round(v.moved);
        // splitTel must never exceed moved — it's the fanned-out PORTION of
        // moved, not an independent figure. The per-run fan-out map only
        // spans blocks scanned in that run (see the ctx.fanout comment
        // above), so a day whose blocks got split across two runs' scans
        // could otherwise accumulate a partial splitTel against a `moved`
        // total that was completed in a different run. Clamping here (the
        // source) rather than in every UI consumer keeps the invariant true
        // by construction wherever this file is read.
        const splitTelRounded = Math.min(Math.round(v.splitTel ?? 0), movedRounded);
        // Prefer explicit sub-fields; fall back so pre-classification days
        // (dex populated, dexSwap/dexLp absent) still surface as swaps.
        const dexRounded = Math.round(v.dex);
        const dexSwapRounded = Math.round(v.dexSwap ?? (v.dexLp != null ? 0 : v.dex) ?? 0);
        const dexLpRounded = Math.round(v.dexLp ?? 0);
        const byChain = {};
        for (const [chainKey, leg] of Object.entries(v.byChain ?? {})) {
          const legDex = Math.round(leg.dex ?? 0);
          byChain[chainKey] = {
            dex: legDex,
            dexSwap: Math.round(leg.dexSwap ?? (leg.dexLp != null ? 0 : leg.dex) ?? 0),
            dexLp: Math.round(leg.dexLp ?? 0),
            cex: Math.round(leg.cex ?? 0), moved: Math.round(leg.moved ?? 0),
            inflows: {
              dex: Math.round(leg.inflows?.dex ?? 0),
              dexSwap: Math.round(leg.inflows?.dexSwap ?? (leg.inflows?.dexLp != null ? 0 : leg.inflows?.dex) ?? 0),
              dexLp: Math.round(leg.inflows?.dexLp ?? 0),
              cex: Math.round(leg.inflows?.cex ?? 0), wallet: Math.round(leg.inflows?.wallet ?? 0),
            },
          };
        }
        // Sparse (omit rounded-zero entries, mirroring byExchange) AND exactly
        // reconciling: the parts of a breakdown must sum to the total the UI
        // shows beside them, or a reader who adds them up finds numbers that
        // disagree. Rounding each entry independently against a separately
        // rounded total cannot guarantee that, and dropping sub-0.5 entries
        // loses their value outright — so whatever residual those two effects
        // produce is folded into `untracked`, which is already the
        // "couldn't attribute this" bucket. `untracked` therefore absorbs both
        // genuinely unattributable flow and rounding dust, and
        // sum(breakdown) === total holds by construction.
        // Breakdowns are apportioned so they sum EXACTLY to the total they sit
        // beside — see scripts/lib/reconcileParts.js for why naive rounding
        // both loses sub-0.5 parts and can produce a negative "untracked".
        const inflowsBySourceTier = reconcileParts(v.inflowsBySourceTier, Math.round(inf.wallet ?? 0));
        const movedByDestTier = reconcileParts(v.movedByDestTier, movedRounded);
        rounded[tier] = {
          dex: dexRounded, dexSwap: dexSwapRounded, dexLp: dexLpRounded,
          cex: Math.round(v.cex), moved: movedRounded,
          // `splitDestinationSlots` is the honest name: it sums destination
          // *slots* across the window, not distinct wallets (the same wallet
          // recurring across days counts once per day) — kept alongside the
          // old `splitWallets` name for one release so the pre-redesign UI
          // (which reads `splitWallets`) doesn't regress to "split into 0
          // wallets" in the gap between this PR and the UI rewrite that
          // reads the new name.
          splitWallets: v.splitWallets ?? 0, splitDestinationSlots: v.splitWallets ?? 0,
          splitEvents: v.splitEvents ?? 0, splitTel: splitTelRounded,
          byExchange, byChain,
          inflows: {
            dex: Math.round(inf.dex ?? 0),
            dexSwap: Math.round(inf.dexSwap ?? (inf.dexLp != null ? 0 : inf.dex) ?? 0),
            dexLp: Math.round(inf.dexLp ?? 0),
            cex: Math.round(inf.cex ?? 0),
            wallet: Math.round(inf.wallet ?? 0),
          },
          inflowsBySourceTier, movedByDestTier,
        };
      }
      return { date, tiers: rounded };
    });

  // Roll the last N days into each fixed window, plus a calendar YTD window.
  const sumWindow = (from) => {
    const tiers = {};
    for (const d of days) {
      if (from && d.date < from) continue;
      for (const [tier, v] of Object.entries(d.tiers)) {
        const t = tiers[tier] ?? emptyTierBucket();
        t.dex += v.dex; t.dexSwap += v.dexSwap ?? 0; t.dexLp += v.dexLp ?? 0;
        t.cex += v.cex; t.moved += v.moved;
        t.splitWallets += v.splitWallets ?? 0; t.splitDestinationSlots = (t.splitDestinationSlots ?? 0) + (v.splitDestinationSlots ?? v.splitWallets ?? 0);
        t.splitEvents += v.splitEvents ?? 0; t.splitTel += v.splitTel ?? 0;
        for (const [n, amt] of Object.entries(v.byExchange ?? {})) t.byExchange[n] = (t.byExchange[n] ?? 0) + amt;
        const inf = v.inflows ?? { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 };
        t.inflows.dex += inf.dex ?? 0;
        t.inflows.dexSwap += inf.dexSwap ?? 0;
        t.inflows.dexLp += inf.dexLp ?? 0;
        t.inflows.cex += inf.cex ?? 0; t.inflows.wallet += inf.wallet ?? 0;
        // Sparse per-chain rollup — a day missing byChain (pre-v10 data, not
        // yet rescanned) simply contributes nothing here rather than an
        // incorrect zero-vs-absent claim; the UI's presence model treats an
        // untouched chain entry as "absent", not "value: 0".
        for (const [chainKey, leg] of Object.entries(v.byChain ?? {})) {
          const c = (t.byChain[chainKey] ??= emptyChainLeg());
          c.dex += leg.dex ?? 0; c.dexSwap += leg.dexSwap ?? 0; c.dexLp += leg.dexLp ?? 0;
          c.cex += leg.cex ?? 0; c.moved += leg.moved ?? 0;
          c.inflows.dex += leg.inflows?.dex ?? 0;
          c.inflows.dexSwap += leg.inflows?.dexSwap ?? 0;
          c.inflows.dexLp += leg.inflows?.dexLp ?? 0;
          c.inflows.cex += leg.inflows?.cex ?? 0; c.inflows.wallet += leg.inflows?.wallet ?? 0;
        }
        // Sparse rollups — a day missing the field (all pre-attribution
        // history) contributes nothing, never a zero that would look like a
        // real (fully-attributed) measurement.
        for (const [k, amt] of Object.entries(v.inflowsBySourceTier ?? {})) t.inflowsBySourceTier[k] = (t.inflowsBySourceTier[k] ?? 0) + amt;
        for (const [k, amt] of Object.entries(v.movedByDestTier ?? {})) t.movedByDestTier[k] = (t.movedByDestTier[k] ?? 0) + amt;
        tiers[tier] = t;
      }
    }
    return tiers;
  };
  // Coverage metadata for the UI's honesty caveat — see
  // scripts/lib/attributionCoverage.js for why "map is non-empty" is the
  // wrong test (it marks all pre-attribution history as covered).
  const sourceTierSince = firstAttributedDate(days);

  const ranges = {};
  for (const win of WINDOWS) {
    // `win` days means the range [latestDate - (win-1), latestDate] inclusive
    // — win-1 days before today, plus today, is win calendar days total.
    // Using dayBefore(latestDate, win) instead (the previous behavior) shifts
    // the start back one day too many, so sumWindow's `d.date >= from` test
    // includes win+1 days — e.g. "1D" silently summed 2 days of flow.
    const from = latestDate ? dayBefore(latestDate, win - 1) : null;
    ranges[String(win)] = { from, to: latestDate ?? null, tiers: sumWindow(from), ...coverageFor(days, from) };
  }
  if (latestDate) {
    const ytdFrom = `${latestDate.slice(0, 4)}-01-01`;
    ranges.ytd = { from: ytdFrom, to: latestDate, tiers: sumWindow(ytdFrom), ...coverageFor(days, ytdFrom) };
  }

  // A chain is "caught up" once its checkpoint sits within a day of blocks of
  // the tip recorded during this run's scanChain() call (or a prior run's, if
  // this run found it already up to date and didn't refetch latest). `complete`
  // is true only once every configured chain has caught up — that's the
  // signal the UI uses to stop showing "data may be incomplete for Polygon/Base".
  const chainComplete = {};
  for (const chainKey of Object.keys(CHAINS)) {
    const c = checkpoint.chains?.[chainKey];
    chainComplete[chainKey] = !!c && c.latest != null && c.lastBlock != null
      && (c.latest - c.lastBlock) <= CHAINS[chainKey].blocksPerDay;
  }
  // Zero chains is vacuously "every chain caught up", which would mark an
  // unscanned Solana project complete and present unmeasured flows as a
  // finished zero. TEL always has its three chains, so this stays the same.
  const complete = Object.keys(CHAINS).length > 0 && Object.values(chainComplete).every(Boolean);

  await fs.mkdir(path.dirname(DAYS_STORE_PATH), { recursive: true });
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(DAYS_STORE_PATH, `${JSON.stringify({ schema: SCHEMA_VERSION, days }, null, 2)}\n`, "utf8");
  await fs.writeFile(OUT_PATH, `${JSON.stringify({ schema: SCHEMA_VERSION, generatedAt: new Date().toISOString(), latestDate: latestDate ?? null, complete, sourceTierSince, ranges }, null, 2)}\n`, "utf8");
  await fs.writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  // Delete the pre-split legacy checkpoint once the new one exists, so a
  // future run doesn't keep reading two sources of truth. Safe to no-op if
  // it's already gone (e.g. a repeat run, or a fresh checkout).
  await fs.rm(LEGACY_CHECKPOINT_PATH, { force: true });
  console.log(`Wrote ${OUT_PATH} (${WINDOWS.length} windows, complete=${complete}) and ${DAYS_STORE_PATH} (${days.length} day buckets).`);
};

main().catch((e) => { console.error(e); process.exit(1); });
