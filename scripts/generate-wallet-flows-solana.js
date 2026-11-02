#!/usr/bin/env node
/**
 * generate-wallet-flows-solana.js [--project <slug>] [--dry-run] [--max-tx N] [--force] [--strict]
 *
 * Solana counterpart of generate-wallet-flows.js: refreshes the GATED "Wallet flows"
 * report for a project's first Solana chain. Output (served only by the forensics gate):
 *   <work>/forensics/wallet-flows.json        the report
 *   <work>/forensics/wallet-flows-state.json  scan cursors + 90-day events, carried between runs
 * <work> is data/<slug> (TEL keeps data/). Each registry wallet's own token account of the mint
 * is scanned; every outflow is classified by destination (scripts/lib/solana/walletFlowScan.js).
 *
 * Helius credits are capped per run: --max-tx | WALLET_FLOWS_MAX_TX (default 2500 transactions),
 * WALLET_FLOWS_PER_WALLET_MAX (default 400), WALLET_FLOWS_MAX_MS (default 20 min). A dry estimate
 * above config/budgets.json perRunWarn.heliusCredits stops the run before any getTransaction call
 * (exit 1) unless --force. --dry-run prints per-wallet signature counts and writes nothing.
 *
 * Follow-up tracing after the scan, under its own call cap: WALLET_FLOWS_FOLLOW_MAX_CALLS (300),
 * _FOLLOW_MAX_TASKS (40), _FOLLOW_MAX_TX (30), WALLET_FLOWS_TRACE_DEPTH (1, max 2), WALLET_FLOWS_SALE_DEPTH
 * (2, max 2), WALLET_FLOWS_TRACE_MIN_TOKENS (100000 whole tokens), WALLET_FLOWS_TRACE_DESTINATIONS (25 rows
 * in the unlabelled-trace section, max 200; totals always cover every destination). A failed follow-up keeps the scan state.
 * Optional report sections, present only with data: `salesJournal` and `unlabelledTrace`.
 *
 * NON-FATAL like generate-wallet-flows.js: on any error the previous report is left untouched and
 * the exit code is 0 (1 with --strict). The budget guard is the one deliberate hard stop.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { projectPaths, projectWork, selectPipelineProject } from "./lib/projects.js";
import { solanaFlowChains, solanaFlowVenues } from "./lib/solana/flowConfig.js";
import { WALLET_FLOWS_FILE, WALLET_FLOWS_REGISTRY_FILE, walletFlowsNotes } from "./lib/walletFlowsProject.js";
import { validateWalletFlowsReport } from "./lib/walletFlows.js";
import {
  aggregateWalletOutflows,
  buildSolanaWalletRows,
  distributionFromRecon,
  sampleTxs,
  solanaSellTotals,
} from "./lib/solana/walletFlowsSolana.js";
import { buildSalesJournal } from "./lib/solana/salesJournal.js";
import { buildUnlabelledTrace } from "./lib/solana/unlabelledTrace.js";

const ROOT = process.cwd();
const WALLET_FLOWS_STATE_FILE = "forensics/wallet-flows-state.json";
const BUDGETS_FILE = path.join(ROOT, "config", "budgets.json");
const DEFAULT_MAX_TX = 2500;
const DEFAULT_PER_WALLET_MAX = 400;
const DEFAULT_MAX_MS = 20 * 60 * 1000;
const DEFAULT_FOLLOW_MS = 10 * 60 * 1000;
const PRICE_TIMEOUT_MS = 10_000;
const PARTIAL_NOTE = "Coverage is partial: older transactions are still being scanned (resumes next run).";
const SOLANA_NOTE =
  "Solana outflows are first-hop SPL transfers classified by owner. Swap proceeds and further hops for unlabelled recipients (WALLET_FLOWS_TRACE_DEPTH, default 1, max 2) are traced within a per-run call cap; large-seller and bot-cluster discovery are not run for this chain.";
const SOL_COINGECKO_ID = "solana";
const FOLLOW_DEFAULTS = {
  maxCalls: 300,
  maxTasks: 40,
  maxTx: 30,
  traceDepth: 1,
  saleDepth: 2,
  minTraceTokens: 100_000,
  traceDestinations: 25,
};
const MAX_TRACE_DEPTH = 2;
const MAX_TRACE_DESTINATIONS = 200;

/** Raw token total (smallest units, BigInt) over the accounts of one getTokenAccountsByOwner result. */
export function rawTokenBalance(response) {
  let total = 0n;
  for (const { account } of response?.value ?? []) {
    const amount = account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
      throw new Error("getTokenAccountsByOwner: token account without a parsed tokenAmount.amount");
    }
    total += BigInt(amount);
  }
  return total;
}

/** Smallest-unit total to UI units. */
export function uiAmount(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}

/** True when a dry estimate plus the follow-up call cap must stop the run: above the per-run warning unless forced. */
export function overBudget(estimate, budgets, force = false, followMaxCalls = 0) {
  if (force) return false;
  return estimate + followMaxCalls > budgets.perRunWarn.heliusCredits;
}

/**
 * Dry-run summary: one line per registry wallet (label, never an RPC URL), then the total.
 * With `followMaxCalls`, the total includes the follow-up cap and a line states it.
 */
export function dryRunLines({ labels, counts, estimatedCredits, budgets, followMaxCalls }) {
  const monthly = budgets.monthly.heliusCredits;
  const credits = estimatedCredits + (followMaxCalls ?? 0);
  const share = ((credits / monthly) * 100).toFixed(2);
  const perWallet = [...labels].map(([address, label]) => `  ${label}: ${counts.perWallet[address] ?? 0} signatures`);
  const followLines = followMaxCalls === undefined ? [] : [`Follow-up tracing is capped at ${followMaxCalls} calls per run.`];
  return [
    ...perWallet,
    `Total: ${counts.signatures} unique signatures, ~${credits} Helius credits for the full backlog ` +
      `(${share}% of the ${monthly} monthly allowance; per-run warning ${budgets.perRunWarn.heliusCredits}; a real run is capped by --max-tx).`,
    ...followLines,
    "Dry run: nothing written.",
  ];
}

const clampDepth = (depth) => Math.min(MAX_TRACE_DEPTH, Math.max(1, depth));

/** Whole number from an env value; anything that is not a positive finite number after flooring falls back. */
function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Follow-up limits from an env-like object. Trace and sale depths are clamped to 1..2;
 * trace destinations (rows in the report) are capped at 200.
 */
export function followLimits(env = process.env) {
  return {
    maxCalls: positiveInt(env.WALLET_FLOWS_FOLLOW_MAX_CALLS, FOLLOW_DEFAULTS.maxCalls),
    maxTasks: positiveInt(env.WALLET_FLOWS_FOLLOW_MAX_TASKS, FOLLOW_DEFAULTS.maxTasks),
    maxTx: positiveInt(env.WALLET_FLOWS_FOLLOW_MAX_TX, FOLLOW_DEFAULTS.maxTx),
    traceDepth: clampDepth(positiveInt(env.WALLET_FLOWS_TRACE_DEPTH, FOLLOW_DEFAULTS.traceDepth)),
    saleDepth: clampDepth(positiveInt(env.WALLET_FLOWS_SALE_DEPTH, FOLLOW_DEFAULTS.saleDepth)),
    minTraceTokens: positiveInt(env.WALLET_FLOWS_TRACE_MIN_TOKENS, FOLLOW_DEFAULTS.minTraceTokens),
    traceDestinations: Math.min(
      MAX_TRACE_DESTINATIONS,
      positiveInt(env.WALLET_FLOWS_TRACE_DESTINATIONS, FOLLOW_DEFAULTS.traceDestinations),
    ),
  };
}

/** Adds only the non-null optional sections. With neither, returns the same report object. */
export function attachSections(report, { salesJournal, unlabelledTrace }) {
  const sections = {
    ...(salesJournal != null ? { salesJournal } : {}),
    ...(unlabelledTrace != null ? { unlabelledTrace } : {}),
  };
  return Object.keys(sections).length === 0 ? report : { ...report, ...sections };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const readJsonOr = async (file, fallback) => {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};
const exists = async (file) => fs.access(file).then(() => true, () => false);

/** Tmp file + rename: a half-written JSON would make the next run lose its cursors. */
async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

/** One CoinGecko request for the project token and SOL. Falls back to the previous report's prices. */
async function fetchPrice(coingeckoId, previous) {
  const carried = {
    priceUsd: previous?.priceUsd ?? 0,
    priceSource: `${previous?.priceSource ?? "unknown"} (carried over)`,
    solUsd: previous?.solUsd ?? 0,
  };
  if (!coingeckoId) return carried;
  try {
    const ids = [...new Set([coingeckoId, SOL_COINGECKO_ID])].join(",");
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`, {
      signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
    });
    const json = await res.json();
    const price = Number(json?.[coingeckoId]?.usd);
    const solPrice = Number(json?.[SOL_COINGECKO_ID]?.usd);
    if (price > 0) {
      return { priceUsd: price, priceSource: `CoinGecko simple/price (${coingeckoId})`, solUsd: solPrice > 0 ? solPrice : carried.solUsd };
    }
  } catch {
    /* fall through to the carried-over prices */
  }
  return carried;
}

/** Error text without RPC URLs: the failover error embeds endpoint prefixes that may carry a key. */
const safeMessage = (error) => String(error?.message ?? error).replace(/https?:\/\/\S+/g, "<rpc url>");

/**
 * Seeds and runs follow-up tasks on the scan state. Any failure keeps the scan state as it was
 * (its own `follow` untouched) and only logs a warning, so the report is still written.
 */
async function withFollowUps(scan, { call, roles, chain, nowSec, limits, deadlineMs }) {
  try {
    const { seedTasks, runFollow } = await import("./lib/solana/followRunner.js");
    const minRaw = BigInt(limits.minTraceTokens) * 10n ** BigInt(chain.decimals);
    const follow0 = seedTasks(scan.state, { nowSec, minRaw, mint: chain.mint, decimals: chain.decimals, maxTraceDepth: limits.traceDepth });
    const { follow } = await runFollow({ call, state: { ...scan.state, follow: follow0 }, roles, nowSec, limits, deadlineMs });
    return { ...scan.state, follow };
  } catch (error) {
    console.warn(`generate-wallet-flows-solana: follow-up tracing skipped — ${safeMessage(error)}`);
    return scan.state;
  }
}

/** Token accounts of `mint` per wallet (for the scan) and the wallet balances (for the report). */
async function fetchWalletAccounts(call, wallets, mint, decimals) {
  const accounts = [];
  const balances = new Map();
  for (const wallet of wallets) {
    const res = await call("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
    for (const { pubkey } of res?.value ?? []) accounts.push({ wallet, tokenAccount: pubkey });
    balances.set(wallet, uiAmount(rawTokenBalance(res), decimals));
  }
  return { accounts, balances };
}

function buildRoles(venues, wallets) {
  return {
    wallets: new Set(wallets),
    cex: new Map(venues.cexWallets.map((w) => [w.address, w.exchange])),
    dex: new Set(venues.dexOwners),
    staking: new Set(venues.stakingAddresses),
  };
}

function buildReport({ project, chain, registry, scan, rows, priceUsd, priceSource, recon, reconRel }) {
  const ticker = project.config?.ticker ?? project.slug.toUpperCase();
  const name = project.config?.name ?? project.slug;
  const notes = [
    ...walletFlowsNotes({ legacy: false, ticker, name }),
    ...(scan.truncated ? [PARTIAL_NOTE] : []),
    SOLANA_NOTE,
  ];
  return {
    version: 1,
    generated: new Date().toISOString(),
    generator: "scripts/generate-wallet-flows-solana.js",
    project: project.slug,
    priceUsd,
    priceSource,
    chains: [chain.key],
    notes,
    distribution: { ...distributionFromRecon(recon), source: reconRel },
    telcoinTotals: solanaSellTotals(rows, priceUsd),
    knownWallets: rows,
    fundingLinks: [],
    botCluster: {
      label: "None tracked",
      chain: chain.key,
      addresses: [],
      balance: 0,
      dexSales: { "72h": 0, "30d": 0, "90d": 0 },
      cexDeposits: { "72h": 0, "30d": 0, "90d": 0 },
    },
    largeSellers: [],
  };
}

async function main(ctx) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const argValue = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  // Dynamic like the RPC modules below: env must be loaded before anything reads it.
  const { loadEnv } = await import("./loadEnv.js");
  await loadEnv();
  const project = selectPipelineProject("generate-wallet-flows-solana", { ported: true });
  const [chain] = solanaFlowChains(project.config);
  if (!chain) {
    console.log(`${project.slug}: no Solana chain; nothing to do.`);
    return;
  }
  const work = projectWork(project);
  const data = projectPaths(project);
  const registryFile = work(WALLET_FLOWS_REGISTRY_FILE);
  if (!(await exists(registryFile))) {
    console.warn(`generate-wallet-flows-solana: no registry at ${path.relative(ROOT, registryFile)} for ${project.slug}; nothing to do.`);
    return;
  }
  const outFile = work(WALLET_FLOWS_FILE);
  ctx.out = outFile;
  const stateFile = work(WALLET_FLOWS_STATE_FILE);
  const reconFile = data("supply-reconciliation.json");
  const registry = await readJson(registryFile);
  const labels = new Map((registry.knownWallets ?? []).map((w) => [w.address, w.label]));
  const wallets = [...labels.keys()];
  const budgets = await readJson(BUDGETS_FILE);
  const limits = followLimits(process.env);

  // Dynamic imports: the modules read RPC env at load, so loadEnv() must run first.
  const { configureSolanaChain, getUsableSolanaRpcUrls, keyedFirst, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
  const { scanWalletFlows } = await import("./lib/solana/walletFlowScan.js");
  configureSolanaChain(chain.chain);
  const urls = keyedFirst(await getUsableSolanaRpcUrls(chain.key), chain.key);
  const call = (method, params) => solanaCallWithFailover(urls, method, params, { chainKey: chain.key });
  const { accounts, balances } = await fetchWalletAccounts(call, wallets, chain.mint, chain.decimals);
  const roles = buildRoles(solanaFlowVenues(project, chain.key, { stakingFeedPath: data("solana-staking.json") }), wallets);

  const prevState = await readJsonOr(stateFile, null);
  const maxTx = Number(argValue("--max-tx") || process.env.WALLET_FLOWS_MAX_TX) || DEFAULT_MAX_TX;
  const perWalletMax = Number(process.env.WALLET_FLOWS_PER_WALLET_MAX) || DEFAULT_PER_WALLET_MAX;
  const deadlineMs = Date.now() + (Number(process.env.WALLET_FLOWS_MAX_MS) || DEFAULT_MAX_MS);
  const nowSec = Math.floor(Date.now() / 1000);
  const scanInput = { call, accounts, mint: chain.mint, roles, state: prevState, nowSec, journal: { dexOwners: roles.dex } };

  const dry = await scanWalletFlows({ ...scanInput, dryRun: true });
  if (dryRun) {
    const lines = dryRunLines({
      labels,
      counts: dry.counts,
      estimatedCredits: dry.estimatedCredits,
      budgets,
      followMaxCalls: limits.maxCalls,
    });
    for (const line of lines) console.log(line);
    return;
  }
  if (overBudget(dry.estimatedCredits, budgets, force, limits.maxCalls)) {
    console.error(
      `generate-wallet-flows-solana: estimated ${dry.estimatedCredits} Helius credits (+${limits.maxCalls} follow-up cap) is above the per-run warning ` +
        `${budgets.perRunWarn.heliusCredits} (config/budgets.json). Nothing fetched; pass --force or lower --max-tx.`,
    );
    process.exitCode = 1;
    return;
  }

  const recon = await readJson(reconFile);
  const scan = await scanWalletFlows({ ...scanInput, caps: { maxTx, perWalletMax, deadlineMs }, dryRun: false });
  // Tracing gets its own time budget so a long scan backlog cannot starve it.
  const followDeadlineMs = Date.now() + (Number(process.env.WALLET_FLOWS_FOLLOW_MAX_MS) || DEFAULT_FOLLOW_MS);
  const state = await withFollowUps(scan, { call, roles, chain, nowSec, limits, deadlineMs: followDeadlineMs });
  await writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const previous = await readJsonOr(outFile, null);
  const { priceUsd, priceSource, solUsd } = await fetchPrice(project.config?.gated?.walletFlows?.coingeckoId ?? null, previous);
  const rows = buildSolanaWalletRows(
    registry,
    aggregateWalletOutflows(state.events, nowSec, chain.decimals),
    balances,
    priceUsd,
    sampleTxs(state.events, nowSec),
  );
  const report = attachSections(
    buildReport({
      project,
      chain,
      registry,
      scan,
      rows,
      priceUsd,
      priceSource,
      recon,
      reconRel: path.relative(ROOT, reconFile).split(path.sep).join("/"),
    }),
    {
      salesJournal: buildSalesJournal({
        sales: state.sales ?? [],
        follow: state.follow,
        registry,
        nowSec,
        zbcnDecimals: chain.decimals,
        solUsd,
      }),
      unlabelledTrace: buildUnlabelledTrace({
        events: state.events,
        follow: state.follow,
        registry,
        nowSec,
        decimals: chain.decimals,
        priceUsd,
        limit: limits.traceDestinations,
      }),
    },
  );

  const errors = validateWalletFlowsReport(report, { addressKind: "base58" });
  if (errors.length) throw new Error(`report failed validation: ${errors.join("; ")}`);
  await writeAtomic(outFile, `${JSON.stringify(report, null, 1)}\n`);
  console.log(
    `Wrote ${path.relative(ROOT, outFile)} (${rows.length} wallets, ${scan.counts.processed} transactions processed` +
      `${scan.truncated ? ", partial: resumes next run" : ""})`,
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const ctx = { out: null };
  main(ctx).catch((error) => {
    console.warn(`generate-wallet-flows-solana: skipped — ${error?.stack ?? error}`);
    if (ctx.out) console.warn(`Previous ${path.relative(ROOT, ctx.out)} left unchanged.`);
    process.exitCode = process.argv.includes("--strict") ? 1 : 0;
  });
}
