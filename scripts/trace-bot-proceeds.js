#!/usr/bin/env node
/**
 * trace-bot-proceeds.js — follow the flagged bot cluster's sale proceeds.
 *
 *   node scripts/trace-bot-proceeds.js --project tel [--max-sales 300] [--dry-run]
 *
 * Reads   data/<slug>/ledger/ledger-checkpoint.json (bot sales from build-ledger.js)
 *         config/projects/<slug>/ledger.json (bot cluster, funding split, venues, trace)
 * Writes  data/<slug>/ledger/bot-proceeds.json
 *
 * For each recent bot sale: sale receipt -> proceeds -> hop 1 -> hop 2, stopping
 * at a CEX, bridge, custody, developer or other known wallet. Every link has its
 * tx hash. Only the developer-funded share (pro-rata by funding) is attributed
 * to developers. A project without a bot cluster gets a small "none" file.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { getAllRpcUrls, rpcCall } from "./lib/rpc.js";
import { selectPipelineProject } from "./lib/projects.js";
import { addr, buildLedgerIndex, ledgerOutRelDir, loadLedgerConfig, validateLedgerConfig } from "./lib/ledger/config.js";
import { alchemyOnly } from "./lib/ledger/evmSource.js";
import { evidenceBlock, summarizeProceeds, traceSale } from "./lib/ledger/proceeds.js";
import { projectChainsAllVms } from "./lib/projects.js";
import { detectBotCandidates } from "./lib/ledger/botDetect.js";

export const BOT_PROCEEDS_VERSION = 1;

const opt = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

export function validateBotProceeds(doc) {
  const errors = [];
  if (doc?.version !== BOT_PROCEEDS_VERSION) errors.push("version must be 1");
  if (!doc?.slug) errors.push("slug missing");
  if (!doc?.summary || !Array.isArray(doc?.chains)) errors.push("summary/chains missing (every report, mapped cluster or not, has the same schema)");
  if (doc?.botCluster === null) return errors;
  if (!doc?.evidence?.summary) errors.push("evidence.summary missing");
  for (const c of doc?.chains ?? []) {
    if (!c.sale?.hash) errors.push("sale without hash");
    for (const p of c.proceeds ?? []) if (!p.hash) errors.push(`proceeds without hash (${c.sale?.hash})`);
    for (const h of c.hops ?? []) if (!h.hash) errors.push(`hop without hash (${c.sale?.hash})`);
  }
  return errors;
}

export async function main(argv = process.argv.slice(2), { root = process.cwd(), logger = console, now = () => Date.now() } = {}) {
  const project = selectPipelineProject("trace-bot-proceeds", { ported: true });
  const cfg = loadLedgerConfig(project.slug, root);
  const problems = validateLedgerConfig(cfg, { projectSlug: project.slug });
  if (problems.length) throw new Error(`ledger config invalid:\n  - ${problems.join("\n  - ")}`);
  const outDir = path.join(root, ledgerOutRelDir(project.slug));
  const outFile = path.join(outDir, "bot-proceeds.json");
  const generated = new Date(now()).toISOString();
  const write = (doc) => {
    const errors = validateBotProceeds(doc);
    if (errors.length) throw new Error(`bot-proceeds invalid:\n  - ${errors.join("\n  - ")}`);
    if (argv.includes("--dry-run")) return logger.log("[trace-bot-proceeds] --dry-run: nothing written");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 1) + "\n");
    logger.log(`[trace-bot-proceeds] wrote ${path.relative(root, outFile)}`);
  };

  const ckPath = path.join(outDir, "ledger-checkpoint.json");
  const ckDoc = fs.existsSync(ckPath) ? JSON.parse(fs.readFileSync(ckPath, "utf8")) : { events: [], botSales: [] };
  // Detection support (every VM): unlabelled wallets the developer wallets keep funding.
  const detection = { candidates: detectBotCandidates(ckDoc.events ?? []), rule: "Candidates are never counted; confirm one by adding a botCluster to the ledger config (docs/LEDGER.md)." };
  if (!cfg.botCluster) {
    // Empty-but-valid: same schema as a traced report, so the UI and tests need no special case.
    write({ version: BOT_PROCEEDS_VERSION, slug: project.slug, generated, status: "no bot cluster mapped", botCluster: null, note: "No bot cluster is mapped for this project.", evidence: null, chains: [], summary: summarizeProceeds([], 0), detection });
    return;
  }
  const ix = buildLedgerIndex(cfg, { project, root });
  const devShare = ix.botShare;
  const chain = cfg.botCluster.chain;
  const chainCfg = projectChainsAllVms(project, root)[chain];
  const evidence = evidenceBlock(cfg.botCluster, devShare);
  const base = {
    version: BOT_PROCEEDS_VERSION,
    slug: project.slug,
    generated,
    botCluster: { label: cfg.botCluster.label, chain, addresses: cfg.botCluster.addresses, devShare: Number(devShare.toFixed(4)) },
    rule: "Only the developer-funded share of the bot's sales and proceeds counts as developer selling (pro-rata by funding).",
    evidence,
    detection,
  };
  if ((chainCfg?.vm ?? "evm") === "solana") {
    await traceSolana({ argv, cfg, chain, chainCfg, ix, devShare, sales: ckDoc.botSales ?? [], base, write, logger });
    return;
  }
  const url = alchemyOnly(getAllRpcUrls(chain))[0];
  const ck = JSON.parse(fs.existsSync(path.join(outDir, "ledger-checkpoint.json")) ? fs.readFileSync(path.join(outDir, "ledger-checkpoint.json"), "utf8") : '{"botSales":[]}');
  if (!url) {
    logger.warn(`[trace-bot-proceeds] no Alchemy key for ${chain}; writing evidence only`);
    write({ ...base, status: `stale: no Alchemy key for ${chain}`, chains: [], summary: summarizeProceeds([], devShare) });
    return;
  }
  const maxSales = Number(opt(argv, "--max-sales") ?? cfg.trace?.maxSales ?? 300);
  const sales = (ck.botSales ?? []).filter((s) => s.chain === chain && Number.isInteger(s.blockNumber)).sort((a, b) => b.time - a.time).slice(0, maxSales);

  const assets = new Map();
  for (const s of [...(cfg.stablecoins?.[chain] ?? []), ...(cfg.trace?.proceedAssets?.[chain] ?? [])]) {
    assets.set(addr(s.address), { asset: (cfg.stablecoins?.[chain] ?? []).some((x) => addr(x.address) === addr(s.address)) ? "stable" : "other", symbol: s.symbol, decimals: s.decimals });
  }
  const soldContracts = new Set(Object.values(chainCfg?.tokens ?? {}).map((t) => addr(t.address)));
  const chains = [];
  for (const sale of sales) {
    try {
      chains.push(await traceSale({ sale, url, rpc: rpcCall, ix, assets, maxHops: cfg.trace?.maxHops ?? 2, devShare, soldContracts }));
    } catch (err) {
      logger.warn(`[trace-bot-proceeds] ${sale.hash}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  const summary = summarizeProceeds(chains, devShare);
  logger.log(`[trace-bot-proceeds] traced ${chains.length}/${sales.length} sales; ${summary.destinations.length} destinations`);
  write({ ...base, status: "ok", chains, summary });
}

/** Solana: same record shape as the EVM path (scripts/lib/ledger/solanaProceeds.js). */
async function traceSolana({ argv, cfg, chain, chainCfg, ix, devShare, sales, base, write, logger }) {
  const { configureSolanaChain, getUsableSolanaRpcUrls, keyedFirst, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
  const { traceSolanaSale } = await import("./lib/ledger/solanaProceeds.js");
  configureSolanaChain(chainCfg);
  const urls = keyedFirst(await getUsableSolanaRpcUrls(chain), chain);
  if (!urls.length) {
    write({ ...base, status: `stale: no usable Solana RPC for ${chain}`, chains: [], summary: summarizeProceeds([], devShare) });
    return;
  }
  const call = (m, p) => solanaCallWithFailover(urls, m, p, { chainKey: chain });
  const assets = new Map();
  for (const s of [...(cfg.stablecoins?.[chain] ?? []), ...(cfg.trace?.proceedAssets?.[chain] ?? [])]) {
    assets.set(s.address, { asset: (cfg.stablecoins?.[chain] ?? []).some((x) => x.address === s.address) ? "stable" : "other", symbol: s.symbol, decimals: s.decimals });
  }
  const soldMints = new Set(Object.values(chainCfg?.tokens ?? {}).map((t) => t.address));
  const maxSales = Number(opt(argv, "--max-sales") ?? cfg.trace?.maxSales ?? 300);
  const picked = sales.filter((s) => s.chain === chain).sort((a, b) => b.time - a.time).slice(0, maxSales);
  const chains = [];
  for (const sale of picked) {
    try {
      chains.push(await traceSolanaSale({ sale, call, ix, assets, maxHops: cfg.trace?.maxHops ?? 2, devShare, soldMints }));
    } catch (err) {
      logger.warn(`[trace-bot-proceeds] ${sale.hash}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  const summary = summarizeProceeds(chains, devShare);
  logger.log(`[trace-bot-proceeds] traced ${chains.length}/${picked.length} Solana sales; ${summary.destinations.length} destinations`);
  write({ ...base, status: "ok", chains, summary });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  // CI: decrypts the Alchemy keys from .env.enc when ENV_PASSPHRASE is set (no-op locally).
  loadEnv().then(() => main()).catch((err) => {
    console.error(`[trace-bot-proceeds] ${err?.stack ?? err}`);
    process.exit(1);
  });
}
