#!/usr/bin/env node
/**
 * generate-wallet-flows.js — refresh the GATED "Wallet flows" forensics report.
 *
 * Output (per project, scripts/lib/walletFlowsProject.js):
 *   TEL (legacyRoot)  data/forensics/wallet-flows.json          (unchanged)
 *   other projects    data/<slug>/forensics/wallet-flows.json
 * NOT public/data — it is never part of the static site or the client bundle;
 * the forensics gate function serves it only after password / admin
 * verification (paywall later). See docs/FORENSICS.md and docs/MULTI-TOKEN.md.
 * Input registry (labels, bot cluster, watched sellers) sits next to it as
 * wallet-flows.registry.json; a project without one is skipped (exit 0).
 *
 * What it recomputes, from on-chain reads only (keyless public RPCs first, then
 * the configured keys — same pool logic as the rest of the pipeline):
 *   1. Every registry wallet's token outflows (legacy + v3) over 72h / 30d / 90d,
 *      classified as CEX / DEX / bot-cluster / upgrade / internal / bridge / ...
 *      (tx receipts are checked for DEX swap events when the destination is
 *      unlabelled), plus a verdict per wallet.
 *   2. Balances (legacy + v3, each with its own decimals) of registry wallets, the
 *      bot cluster and the watched sellers.
 *   3. The bot cluster's DEX sales per window.
 *   4. 72h large-seller discovery over ALL TEL transfers (skip with --skip-sellers).
 *   5. Supply distribution by entity class, from the project's supply-reconciliation.json
 *      plus the balances above.
 * Funding links are carried over from the previous report (they come from manual
 * inbound tracing and are not recomputed).
 *
 * NON-FATAL BY DESIGN: on any error the previous report is left untouched and the
 * script exits 0 (use --strict to exit 1). It must never break the data pipeline.
 *
 * Usage:
 *   node scripts/generate-wallet-flows.js [--project <slug>] [--out <path>] [--recon <path>]
 *        [--skip-sellers] [--dry-run] [--strict] [--chains ethereum,polygon,base]
 *        [--source rpc|portal] [--as-of <YYYY-MM-DD|ISO>]
 * Backfill: `--as-of` anchors the 72h/30d/90d windows to that moment and requires `--out`
 * (a file other than the live report, never under public/). Balances and USD values are null
 * in that output (see scripts/lib/walletFlowsAsOf.js). docs/FORENSICS.md "Backfill via SQD Portal".
 * Env: RPC_PREFER_PUBLIC=1 recommended; PUBLIC_RPC_URLS_<CHAIN> to override.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getUsableRpcUrls, getLogs, rpcCall } from "./lib/rpc.js";
import { createLogsFailover } from "./lib/logsFailover.js";
import { confirmationsFor, createLogScanner, parseSource } from "./lib/logSource.js";
import { anchorSeconds, parseWalletFlowArgs } from "./lib/walletFlowArgs.js";
import { applyAsOfNulls, asOfPrice } from "./lib/walletFlowsAsOf.js";
import {
  assertPortalComplete,
  completenessSampleConfig,
  describeCompleteness,
  verifyPortalCompleteness,
} from "./lib/portalCompleteness.js";
import { resolveChainTokens, rawToTel } from "./lib/telTokens.js";
import {
  SWAP_TOPICS,
  WINDOWS,
  WINDOW_SECONDS,
  aggregateOutflows,
  buildDistribution,
  buildKnownWalletRows,
  buildVenueIndex,
  classifyOutflow,
  discoverLargeSellers,
  norm,
  telcoinSellTotals,
  validateWalletFlowsReport,
} from "./lib/walletFlows.js";
import { loadProjectClassification, selectPipelineProject } from "./lib/projects.js";
import { tokenSlots, walletFlowsNotes, walletFlowsPlan } from "./lib/walletFlowsProject.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Every path and address
// comes from the project (walletFlowsPlan); TEL resolves to its original files.
const PROJECT = selectPipelineProject("generate-wallet-flows", { ported: true });

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ROOT = process.cwd();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
let PLAN;
try {
  PLAN = walletFlowsPlan(PROJECT, { root: ROOT, argv });
} catch (error) {
  // Non-fatal like the rest of this script (--strict exits 1).
  console.warn(`generate-wallet-flows: skipped — ${error?.message ?? error}`);
  process.exit(argv.includes("--strict") ? 1 : 0);
}
const OUT = PLAN.out;
const RECON = PLAN.recon;
const REGISTRY = PLAN.registry;
const CHAINS = PLAN.chains;
const STRICT = flag("--strict");
const DRY = flag("--dry-run");
const SKIP_SELLERS = flag("--skip-sellers");
/** `--source rpc|portal` or HD_BACKFILL_SOURCE; an unknown value is a hard error. */
let SOURCE;
try {
  SOURCE = parseSource({ argv, env: process.env });
} catch (error) {
  console.error(`generate-wallet-flows: ${error?.message ?? error}`);
  process.exit(1);
}
/** `--as-of` / `--out` backfill guards. Invalid combinations exit 1 before any RPC call. */
let BACKFILL;
try {
  const liveOut = walletFlowsPlan(PROJECT, { root: ROOT, argv: [] }).out;
  BACKFILL = parseWalletFlowArgs({ argv, root: ROOT, liveOut });
} catch (error) {
  console.error(`generate-wallet-flows: ${error?.message ?? error}`);
  process.exit(1);
}
const AS_OF = BACKFILL.asOf;
/** Initial getLogs span per chain; rpc.getLogs bisects automatically when a node refuses. */
const SPAN = (chain) => PLAN.logSpan(chain);
const MAX_RECEIPTS = Number(process.env.WALLET_FLOWS_MAX_RECEIPTS) || 2500;
const MIN_SELLER_TEL = Number(process.env.WALLET_FLOWS_MIN_SELLER_TEL) || 5e6;

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const readJsonOr = async (p, fallback) => {
  try {
    return await readJson(p);
  } catch {
    return fallback;
  }
};
const pad = (a) => "0x" + norm(a).replace("0x", "").padStart(64, "0");
const hex = (n) => "0x" + n.toString(16);

async function viaPool(urls, fn) {
  let last;
  for (const url of urls) {
    try {
      return await fn(url);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const blockTs = async (urls, n) =>
  Number.parseInt((await viaPool(urls, (u) => rpcCall(u, "eth_getBlockByNumber", [hex(n), false]))).timestamp, 16);

/** First block with timestamp >= target (binary search). */
async function blockAtOrAfter(urls, target, head, headTs) {
  let lo = 0;
  let hi = head;
  // Narrow the bracket with a rate estimate first (saves ~15 round trips).
  const sample = Math.max(0, head - 100_000);
  const rate = (headTs - (await blockTs(urls, sample))) / (head - sample);
  const guess = Math.max(0, Math.floor(head - (headTs - target) / rate));
  for (let back = 2000; ; back *= 4) {
    const lower = Math.max(0, guess - back);
    if (lower === 0 || (await blockTs(urls, lower)) < target) {
      lo = lower;
      break;
    }
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTs(urls, mid)) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Portal is used only when the caller passes `{ allowPortal: true }` (see logSource.js). */
const scanLogs = (scanner, filterBase, from, to, options) => scanner.scan(filterBase, from, to, options);

/**
 * Portal-only gate: compares the Portal log set with RPC on sampled windows and throws
 * (before any output is written) on a mismatch. `head - confirmations` is the end Portal scans to.
 */
async function checkPortalCompleteness({ chain, urls, failover, filterBase, portalLogs, from, head }) {
  const check = await verifyPortalCompleteness({
    chain,
    urls,
    failover,
    filterBase,
    portalLogs,
    fromBlock: from,
    toBlock: head - confirmationsFor(chain),
    sample: completenessSampleConfig(process.env, SPAN(chain)),
  });
  console.log(describeCompleteness(check));
  assertPortalComplete(check);
}

function toTransfers(chain, logs, slotByToken) {
  const out = [];
  for (const log of logs) {
    const topics = log.topics ?? [];
    if (topics.length < 3) continue;
    const slot = slotByToken.get(norm(log.address));
    if (!slot) continue;
    const { decimals } = slot;
    const raw = BigInt(log.data && log.data !== "0x" ? log.data.slice(0, 66) : "0x0");
    out.push({
      chain,
      token: slot.slot,
      from: "0x" + topics[1].slice(-40).toLowerCase(),
      to: "0x" + topics[2].slice(-40).toLowerCase(),
      tel: rawToTel(raw, decimals),
      tx: norm(log.transactionHash),
      block: Number.parseInt(log.blockNumber, 16),
    });
  }
  return out;
}

async function markSwaps(urls, transfers, budget) {
  const txs = [...new Set(transfers.map((t) => t.tx))].slice(0, budget.left);
  budget.left -= txs.length;
  const swapped = new Set();
  await pool(txs, 4, async (tx) => {
    try {
      const r = await viaPool(urls, (u) => rpcCall(u, "eth_getTransactionReceipt", [tx]));
      if ((r?.logs ?? []).some((l) => SWAP_TOPICS.has(norm(l.topics?.[0])))) swapped.add(tx);
    } catch {
      /* unknown → left unlabelled */
    }
  });
  for (const t of transfers) if (swapped.has(t.tx)) t.swapped = true;
}

async function balanceOf(urls, token, holder) {
  const data = "0x70a08231" + pad(holder).slice(2);
  const res = await viaPool(urls, (u) => rpcCall(u, "eth_call", [{ to: token, data }, "latest"]));
  return BigInt(res && res !== "0x" ? res : "0x0");
}

async function fetchPrice(previous) {
  const id = PLAN.coingeckoId;
  if (id) {
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`, {
        signal: AbortSignal.timeout(10_000),
      });
      const j = await res.json();
      const p = Number(j?.[id]?.usd);
      if (p > 0) return { priceUsd: p, priceSource: `CoinGecko simple/price (${id})` };
    } catch {
      /* fall through */
    }
  }
  return { priceUsd: previous?.priceUsd ?? 0, priceSource: `${previous?.priceSource ?? "unknown"} (carried over)` };
}

async function main() {
  const chainsCfg = PLAN.chainsCfg;
  const cexCfg = loadProjectClassification(PROJECT, "cexWallets", { wallets: [] }, ROOT);
  const dexCfg = loadProjectClassification(PROJECT, "dexContracts", {}, ROOT);
  const [registry, recon, previous] = await Promise.all([readJson(REGISTRY), readJson(RECON), readJsonOr(OUT, null)]);
  // --as-of: no live price (it would be the price today, not on the anchor date).
  const { priceUsd, priceSource } = AS_OF ? asOfPrice(AS_OF.iso) : await fetchPrice(previous);

  const upgradeContracts = [];
  for (const c of CHAINS) upgradeContracts.push(...resolveChainTokens(chainsCfg[c]).escrow);
  const dexAddresses = [
    ...(dexCfg.pools ?? []).map((p) => p.address),
    ...(dexCfg.routers ?? []).map((r) => r.address ?? r),
    ...PLAN.dexVenues,
  ].filter(Boolean);
  const index = buildVenueIndex({
    registry,
    cexWallets: cexCfg.wallets ?? cexCfg,
    dexAddresses,
    recon,
    upgradeContracts,
    bridgeAddresses: PLAN.bridgeAddresses,
  });

  const knownAddrs = (registry.knownWallets ?? []).map((w) => norm(w.address));
  const botAddrs = (registry.botCluster?.addresses ?? []).map(norm);
  const sellerAddrs = (registry.watchedSellers ?? []).map((s) => norm(s.address));
  const balanceAddrs = [...new Set([...knownAddrs, ...botAddrs, ...sellerAddrs])];

  const startBlocks = {};
  const windows = {};
  const tracked = [];
  const balances = new Map();
  const allTransfers = [];
  const sellerTransfers = [];
  const budget = { left: MAX_RECEIPTS };
  const now = anchorSeconds(AS_OF, Date.now());
  const failover = createLogsFailover(getLogs);
  if (AS_OF) console.log(`as-of ${AS_OF.iso}: windows anchored there; balances and USD values will be null`);

  for (const chain of CHAINS) {
    const urls = await getUsableRpcUrls(chain);
    if (urls.length === 0) throw new Error(`no RPC for ${chain}`);
    const tokens = resolveChainTokens(chainsCfg[chain]);
    const tokenList = [tokens.legacy, ...(tokens.v3 ? [tokens.v3] : [])];
    const slotByToken = tokenSlots(tokens);
    const liveHead = Number.parseInt(await viaPool(urls, (u) => rpcCall(u, "eth_blockNumber", [])), 16);
    const liveHeadTs = await blockTs(urls, liveHead);
    // --as-of: the scan head becomes the first block at or after the anchor, so every window ends there.
    const head = AS_OF ? await blockAtOrAfter(urls, now, liveHead, liveHeadTs) : liveHead;
    const headTs = AS_OF ? await blockTs(urls, head) : liveHeadTs;
    startBlocks[chain] = {};
    for (const win of WINDOWS) {
      startBlocks[chain][win] = await blockAtOrAfter(urls, now - WINDOW_SECONDS[win], head, headTs);
    }
    windows[chain] = { head, headTime: new Date(headTs * 1000).toISOString(), startBlocks: startBlocks[chain] };
    console.log(`${chain}: head ${head}, 90d from ${startBlocks[chain]["90d"]}`);
    const scanner = createLogScanner({ source: SOURCE, chain, head, urls, failover, span: SPAN(chain), pool });
    console.log(`${chain}: log source ${scanner.source}`);

    // 1+3. Outflows from registry wallets and the bot cluster (topic1 = sender).
    // Always RPC: sender lists are never sent to Portal (decision D2).
    const senders = [...new Set([...knownAddrs, ...botAddrs])].map(pad);
    const logs = await scanLogs(
      scanner,
      { address: tokenList.map((t) => t.address), topics: [TRANSFER, senders] },
      startBlocks[chain]["90d"],
      head,
    );
    const transfers = toTransfers(chain, logs, slotByToken);
    const unlabelled = transfers.filter(
      (t) => t.tel >= 1e6 && !index.bots.has(t.from) && classifyOutflow(t.from, t.to, index) === "unlabelled",
    );
    await markSwaps(urls, unlabelled, budget);
    allTransfers.push(...transfers);
    console.log(`${chain}: ${transfers.length} outflows from tracked wallets`);

    // 4. 72h large-seller discovery (every TEL transfer in the window).
    if (!SKIP_SELLERS) {
      const sellerFilter = { address: tokenList.map((t) => t.address), topics: [TRANSFER] };
      try {
        const portalLogs = await scanLogs(scanner, sellerFilter, startBlocks[chain]["72h"], head, { allowPortal: true });
        if (SOURCE === "portal") {
          await checkPortalCompleteness({ chain, urls, failover, filterBase: sellerFilter, portalLogs, from: startBlocks[chain]["72h"], head });
        }
        const all = toTransfers(chain, portalLogs, slotByToken);
        const perSender = new Map();
        for (const t of all) {
          if (classifyOutflow(t.from, t.to, index) !== "unlabelled") continue;
          perSender.set(t.from, (perSender.get(t.from) ?? 0) + t.tel);
        }
        const heavy = new Set([...perSender].filter(([, v]) => v >= MIN_SELLER_TEL).map(([a]) => a));
        await markSwaps(urls, all.filter((t) => heavy.has(t.from)), budget);
        sellerTransfers.push(...all);
        console.log(`${chain}: ${all.length} transfers in 72h`);
      } catch (error) {
        // Portal caps, reorgs and failed completeness checks must stop the run; only RPC failures fall back to the previous list.
        if (["PortalError", "PortalReorgError", "PortalCompletenessError"].includes(error?.name)) throw error;
        console.warn(`${chain}: 72h seller scan failed (${String(error?.message ?? error).slice(0, 120)}) — keeping previous sellers list`);
        sellerTransfers.failed = true;
      }
    }

    // 2. Balances. Skipped for --as-of: eth_call reads the current state, so nulls are written instead.
    if (!AS_OF) {
      await pool(balanceAddrs, 4, async (a) => {
        const detail = balances.get(a) ?? {};
        for (const t of tokenList) {
          const raw = await balanceOf(urls, t.address, a);
          if (raw > 0n) detail[`${chain}_${slotByToken.get(t.address).slot}`] = rawToTel(raw, t.decimals);
        }
        balances.set(a, detail);
      });
    }
  }

  const { byWallet, bot } = aggregateOutflows(allTransfers, index, startBlocks);
  const knownWallets = buildKnownWalletRows(registry, byWallet, balances, priceUsd);
  const sumBal = (a) => Object.values(balances.get(a) ?? {}).reduce((s, v) => s + v, 0);
  for (const w of registry.knownWallets ?? []) tracked.push({ address: w.address, entityClass: w.entityClass, balance: sumBal(norm(w.address)) });
  for (const a of botAddrs) tracked.push({ address: a, entityClass: "bots", balance: sumBal(a) });
  for (const a of sellerAddrs) tracked.push({ address: a, entityClass: "seller", balance: sumBal(a) });

  const largeSellers =
    SKIP_SELLERS || sellerTransfers.failed
      ? previous?.largeSellers ?? []
      : discoverLargeSellers(sellerTransfers, index, { minTel: MIN_SELLER_TEL, priceUsd });

  const builtReport = {
    version: 1,
    generated: new Date().toISOString(),
    generator: "scripts/generate-wallet-flows.js",
    ...(PLAN.legacy ? {} : { project: PLAN.slug }),
    priceUsd,
    priceSource,
    chains: CHAINS,
    windows,
    notes: [...walletFlowsNotes(PLAN), ...(SOURCE === "portal" ? ["source: portal"] : [])],
    distribution: { ...buildDistribution(recon, tracked), source: path.relative(ROOT, RECON).split(path.sep).join("/") },
    telcoinTotals: telcoinSellTotals(knownWallets, priceUsd),
    knownWallets,
    fundingLinks: previous?.fundingLinks ?? [],
    botCluster: {
      label: registry.botCluster?.label,
      chain: registry.botCluster?.chain,
      note: registry.botCluster?.note,
      addresses: botAddrs,
      balance: Math.round(botAddrs.reduce((s, a) => s + sumBal(a), 0)),
      dexSales: Object.fromEntries(WINDOWS.map((w) => [w, Math.round(bot.out[w].DEX ?? 0)])),
      cexDeposits: Object.fromEntries(WINDOWS.map((w) => [w, Math.round(bot.out[w].CEX ?? 0)])),
    },
    largeSellers,
  };
  const report = AS_OF ? applyAsOfNulls(builtReport, AS_OF) : builtReport;

  const errors = validateWalletFlowsReport(report);
  if (errors.length) throw new Error(`report failed validation: ${errors.join("; ")}`);
  if (DRY) {
    console.log(JSON.stringify({ telcoinTotals: report.telcoinTotals, botCluster: report.botCluster, sellers: report.largeSellers.slice(0, 5) }, null, 2));
    return;
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(report, null, 1) + "\n");
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${knownWallets.length} wallets, ${largeSellers.length} sellers)`);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  // A project with no forensics registry yet has nothing to trace: skip before
  // any RPC call (the gate then serves "no report" for that project).
  if (!(await exists(REGISTRY))) {
    console.warn(`generate-wallet-flows: no registry at ${path.relative(ROOT, REGISTRY)} for ${PLAN.slug}; nothing to do.`);
    return;
  }
  await main();
})().catch((error) => {
  console.warn(`generate-wallet-flows: skipped — ${error?.stack ?? error}`);
  console.warn(`Previous ${path.relative(ROOT, OUT)} left unchanged.`);
  // A failed Portal completeness check is never a silent skip: exit 1 even without --strict.
  process.exitCode = STRICT || error?.name === "PortalCompletenessError" ? 1 : 0;
});
