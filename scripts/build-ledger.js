#!/usr/bin/env node
/**
 * build-ledger.js — developer-wallet ledger for one project (docs/LEDGER.md).
 *
 *   node scripts/build-ledger.js --project tel [--chains polygon,ethereum] [--rebuild] [--dry-run] [--skip-cross-check] [--max-tx 4000]
 *
 * Reads   config/projects/<slug>/ledger.json, config/ledger-tx-types.json,
 *         the project's chain map / CEX / DEX lists.
 * Writes  data/<slug>/ledger/ledger.json             derived report (gated, never under public/)
 *         data/<slug>/ledger/ledger-checkpoint.json  per-chain cursors + retained events
 *
 * Incremental: each chain resumes from its checkpoint (EVM: lastBlock; Solana:
 * one signature cursor per account). A chain that cannot be scanned this run
 * (no key, RPC down) keeps its previous events and cursor and is reported in
 * `coverage`, never silently zeroed.
 *
 * Providers: EVM = paid Alchemy (alchemy_getAssetTransfers, <PREFIX>_RPC_n keys
 * that point at alchemy.com) + receipts; Etherscan v2 free tier is a count
 * cross-check only. Solana = SOLANA_RPC_0 (Helius) then SOLANA_RPC_1 (public).
 *
 * The old TEL disposition ledger (data/association-forensics/*) is untouched.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { getAllRpcUrls, getPublicFallbackUrls, getLogs, rpcCall } from "./lib/rpc.js";
import { resolveJobEnv } from "./lib/rpcMetrics.js";
import { projectChainsAllVms, selectPipelineProject } from "./lib/projects.js";
import {
  buildLedgerIndex,
  ledgerOutRelDir,
  loadLedgerConfig,
  loadTxTypes,
  validateLedgerConfig,
  walletsForChain,
} from "./lib/ledger/config.js";
import { classifyBotTransfer, classifyTransfer } from "./lib/ledger/classify.js";
import { buildLedgerReport, validateLedgerReport } from "./lib/ledger/aggregate.js";
import { alchemyOnly, evmAssetMap, ledgerEvmProviderOrder, logsAssetTransfers, scanEvmChain } from "./lib/ledger/evmSource.js";
import { scanSolanaChain } from "./lib/ledger/solanaSource.js";

export const CHECKPOINT_VERSION = 1;
const DAY = 86400;

const flag = (argv, name) => argv.includes(name);
const opt = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

export function emptyCheckpoint(slug) {
  return { version: CHECKPOINT_VERSION, slug, updated: null, chains: {}, events: [], botSales: [] };
}

/** Merge new rows into retained ones (dedupe by uniqueId) and prune to historyDays. */
export function mergeRows(prev, next, { nowSec, historyDays }) {
  const since = nowSec - historyDays * DAY;
  const m = new Map();
  for (const r of [...prev, ...next]) if (r.time >= since) m.set(r.uniqueId ?? `${r.hash}:${r.wallet}:${r.amount}`, r);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function crossCheckEtherscan({ chain, chainCfg, wallets, transfers, fromBlock, toBlock, assets, logger }) {
  const { createEtherscanKeyPool, fetchAddressTransfers, keysFromEnv } = await import("./lib/etherscanMultiKey.js");
  const keys = keysFromEnv();
  if (!keys.length || !chainCfg?.chainId) return { chain, status: "skipped (no ETHERSCAN_API_KEY)" };
  const pool = createEtherscanKeyPool(keys);
  const token = [...assets].find(([, a]) => a.asset === "token")?.[0];
  const rows = [];
  for (const w of wallets.slice(0, 3)) {
    const a = w.address.toLowerCase();
    try {
      const es = await fetchAddressTransfers(pool, { chainId: chainCfg.chainId, address: a, contractAddress: token, startBlock: fromBlock, endBlock: toBlock });
      const al = transfers.filter((t) => t.contract === token && (t.from === a || t.to === a)).length;
      rows.push({ address: a, alchemy: al, etherscan: es.filter((t) => t.value > 0n).length });
    } catch (err) {
      logger.warn(`${chain}: Etherscan cross-check ${a} failed (${String(err?.message ?? err).slice(0, 80)})`);
    }
  }
  return { chain, status: "checked", fromBlock, toBlock, rows, mismatches: rows.filter((r) => r.alchemy !== r.etherscan).length };
}

export async function main(argv = process.argv.slice(2), { root = process.cwd(), logger = console, now = () => Date.now() } = {}) {
  const project = selectPipelineProject("build-ledger", { ported: true });
  const cfg = loadLedgerConfig(project.slug, root);
  const problems = validateLedgerConfig(cfg, { projectSlug: project.slug });
  if (problems.length) throw new Error(`ledger config invalid:\n  - ${problems.join("\n  - ")}`);
  const txTypes = loadTxTypes(root);
  const ix = buildLedgerIndex(cfg, { project, root });
  const nowSec = Math.floor(now() / 1000);
  const historyDays = cfg.historyDays ?? 90;
  const outDir = path.join(root, ledgerOutRelDir(project.slug));
  const ckFile = path.join(outDir, "ledger-checkpoint.json");
  const outFile = path.join(outDir, "ledger.json");
  const ck = flag(argv, "--rebuild") ? emptyCheckpoint(project.slug) : readJson(ckFile, emptyCheckpoint(project.slug));
  const chainMap = projectChainsAllVms(project, root);
  const only = opt(argv, "--chains")?.split(",").map((s) => s.trim());
  const ticker = project.config?.ticker ?? project.slug.toUpperCase();
  const types = txTypes.types;

  const coverage = {};
  const crossCheck = [];
  const newEvents = [];
  const newBot = [];
  const isLabelled = (a) => !!a && (ix.dev.has(a) || ix.cex.has(a) || ix.dex.has(a) || ix.bridges.has(a) || ix.custody.has(a) || ix.staking.has(a) || ix.relays.has(a) || ix.bot.has(a));

  for (const chain of cfg.chains) {
    if (only && !only.includes(chain)) {
      coverage[chain] = { ...(ck.chains[chain] ?? {}), status: "not selected this run" };
      continue;
    }
    const chainCfg = chainMap[chain];
    if (!chainCfg) {
      coverage[chain] = { status: `chain ${chain} is not in the project's chain map` };
      continue;
    }
    const vm = chainCfg.vm ?? "evm";
    const stables = cfg.stablecoins?.[chain] ?? [];
    const wallets = walletsForChain(cfg, chain, vm);
    const botAddrs = cfg.botCluster?.chain === chain ? cfg.botCluster.addresses : [];
    try {
      if (vm === "solana") {
        const { configureSolanaChain, getUsableSolanaRpcUrls, keyedFirst, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
        const { associatedTokenAddress } = await import("./lib/solana/zebecStake.js");
        const { PROGRAM_BY_NAME } = await import("./lib/solana/metadata.js");
        configureSolanaChain(chainCfg);
        const urls = keyedFirst(await getUsableSolanaRpcUrls(chain), chain);
        if (!urls.length) throw new Error("no usable Solana RPC (SOLANA_RPC_0 / SOLANA_RPC_1 / public)");
        const call = (m, p) => solanaCallWithFailover(urls, m, p, { chainKey: chain });
        const assets = new Map();
        for (const t of Object.values(chainCfg.tokens ?? {})) assets.set(t.address, { asset: "token", symbol: ticker, decimals: t.decimals, program: t.program ?? "spl-token" });
        for (const s of stables) assets.set(s.address, { asset: "stable", symbol: s.symbol, decimals: s.decimals, program: "spl-token" });
        const owners = [...wallets.map((w) => w.address), ...botAddrs];
        const accounts = [];
        for (const o of owners) {
          accounts.push({ wallet: o, account: o });
          for (const [mint, a] of assets) accounts.push({ wallet: o, account: associatedTokenAddress(o, mint, PROGRAM_BY_NAME[a.program]) });
        }
        const res = await scanSolanaChain({ chain, call, accounts, assets, watched: new Set(owners), checkpoint: ck.chains[chain], nowSec, historyDays, logger, maxTx: Number(opt(argv, "--max-tx") ?? 4000) });
        for (const t of res.transfers) {
          const ev = classifyTransfer(t, ix, types);
          if (ev) newEvents.push({ ...ev, uniqueId: t.uniqueId });
          const b = classifyBotTransfer(t, ix);
          if (b) newBot.push({ ...b, uniqueId: t.uniqueId });
        }
        ck.chains[chain] = res.cursor;
        coverage[chain] = { status: res.stats.backlog ? `partial (${res.stats.backlog} signatures left for the next run)` : "ok", provider: "solana-rpc", ...res.stats, headTime: res.cursor.headTime };
      } else {
        const assets = evmAssetMap(chainCfg, stables, ticker);
        // Provider order from config/nightly-jobs.json (job "ledger"): keyless
        // public eth_getLogs first, Alchemy last. Same rows either way
        // (evmSource.js logsAssetTransfers). No job env -> Alchemy, as before.
        const attempts = [];
        for (const p of ledgerEvmProviderOrder(resolveJobEnv(process.env))) {
          if (p === "public") for (const u of getPublicFallbackUrls(chain)) attempts.push({ provider: "public-rpc", url: u, assetTransfers: logsAssetTransfers({ rpc: rpcCall, getLogs }) });
          if (p === "alchemy") for (const u of alchemyOnly(getAllRpcUrls(chain)).slice(0, 1)) attempts.push({ provider: "alchemy", url: u });
        }
        if (!attempts.length) throw new Error(`no ledger provider for ${chain}: no public RPC listed and no Alchemy key in ${chain} RPC env (alchemy_getAssetTransfers needs an alchemy.com <PREFIX>_RPC_n URL)`);
        let res;
        let provider;
        let lastErr;
        for (const a of attempts) {
          try {
            res = await scanEvmChain({ chain, url: a.url, rpc: rpcCall, assets, wallets, botAddresses: botAddrs, checkpoint: ck.chains[chain], nowSec, historyDays, isLabelled, logger, ...(a.assetTransfers ? { assetTransfers: a.assetTransfers } : {}) });
            provider = a.provider;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn?.(`${chain}: ledger scan via ${a.provider} failed (${String(err?.message ?? err).slice(0, 120)}) — trying the next provider`);
          }
        }
        if (!res) throw lastErr;
        for (const t of res.transfers) {
          const ev = classifyTransfer(t, ix, types);
          if (ev) newEvents.push({ ...ev, uniqueId: t.uniqueId, blockNumber: t.blockNumber });
        }
        for (const t of res.botTransfers) {
          const b = classifyBotTransfer(t, ix);
          if (b) newBot.push({ ...b, uniqueId: t.uniqueId, blockNumber: t.blockNumber });
        }
        ck.chains[chain] = res.cursor;
        coverage[chain] = { status: "ok", provider, ...res.stats, headTime: res.cursor.headTime };
        if (!flag(argv, "--skip-cross-check") && res.transfers.length) {
          crossCheck.push(await crossCheckEtherscan({ chain, chainCfg, wallets, transfers: res.transfers, fromBlock: res.stats.fromBlock, toBlock: res.stats.head, assets, logger }));
        }
      }
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 200);
      logger.warn(`[build-ledger] ${chain}: ${msg} — keeping the previous ${chain} events and cursor`);
      coverage[chain] = { ...(ck.chains[chain] ?? {}), status: `stale: ${msg}` };
    }
  }

  const scanned = Object.values(coverage).some((c) => c.status === "ok" || String(c.status).startsWith("partial"));
  if (!scanned && !ck.updated) {
    throw new Error("no chain could be scanned and there is no previous checkpoint; refusing to write an empty ledger (see coverage above)");
  }

  ck.events = mergeRows(ck.events ?? [], newEvents, { nowSec, historyDays });
  ck.botSales = mergeRows(ck.botSales ?? [], newBot, { nowSec, historyDays });
  ck.updated = new Date(nowSec * 1000).toISOString();

  const report = buildLedgerReport({
    cfg,
    events: ck.events,
    botSales: ck.botSales,
    nowSec,
    txTypes,
    coverage,
    crossCheck: crossCheck.length ? crossCheck : null,
    project: { name: project.config?.name, ticker },
    devShare: ix.botShare,
  });
  const errors = validateLedgerReport(report);
  if (errors.length) throw new Error(`ledger report invalid:\n  - ${errors.join("\n  - ")}`);

  logger.log(`[build-ledger] ${project.slug}: ${ck.events.length} events, ${ck.botSales.length} bot sales; 30d developer selling ${report.byWindow["30d"]?.devSold.total ?? "n/a"} ${ticker}`);
  for (const [c, v] of Object.entries(coverage)) logger.log(`  ${c}: ${v.status}`);
  if (flag(argv, "--dry-run")) {
    logger.log("[build-ledger] --dry-run: nothing written");
    return report;
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + "\n");
  fs.writeFileSync(ckFile, JSON.stringify(ck) + "\n");
  logger.log(`[build-ledger] wrote ${path.relative(root, outFile)} and ${path.relative(root, ckFile)}`);
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  // CI: decrypts the Alchemy keys from .env.enc when ENV_PASSPHRASE is set (no-op locally).
  loadEnv().then(() => main()).catch((err) => {
    console.error(`[build-ledger] ${err?.stack ?? err}`);
    process.exit(1);
  });
}
