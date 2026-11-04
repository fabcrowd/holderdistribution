#!/usr/bin/env node
/**
 * add-project.js — scaffold a new mapped project in one command, then validate it.
 *
 *   node scripts/add-project.js --slug foo --name "Foo Network" --ticker FOO \
 *     --chain ethereum:0xTOKEN:18[:chainId[:deployBlock]] [--chain solana:MINT:6] \
 *     [--wallet <address>:<label>[:treasury|holdings|association]] ... \
 *     [--coingecko foo-network] [--stable ethereum:0xUSDC:USDC:6] [--dry-run] [--force] [--root <dir>]
 *
 * Writes (refuses to overwrite without --force):
 *   config/projects.json                                   + registry entry (appended)
 *   config/projects/<slug>.json                            project config
 *   config/projects/<slug>/ledger.json                     developer-wallet ledger config
 *   data/<slug>/forensics/wallet-flows.registry.json       wallet registry (empty unless --wallet given)
 *
 * Then validates the project config (scripts/lib/projects.js) and the ledger
 * config (scripts/lib/ledger/config.js) and prints what is left to do by hand
 * (verify addresses, image, CEX/DEX lists, first pipeline run). Never touches
 * public/data and never commits.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { SLUG_RE, validateProjectConfig } from "./lib/projects.js";
import { isEvmAddress, isSolanaAddress, LEDGER_WINDOWS, validateLedgerConfig } from "./lib/ledger/config.js";

const KNOWN_EVM = {
  ethereum: { name: "Ethereum", chainId: 1, explorer: "https://etherscan.io" },
  polygon: { name: "Polygon", chainId: 137, explorer: "https://polygonscan.com" },
  base: { name: "Base", chainId: 8453, explorer: "https://basescan.org" },
  arbitrum: { name: "Arbitrum One", chainId: 42161, explorer: "https://arbiscan.io" },
  optimism: { name: "OP Mainnet", chainId: 10, explorer: "https://optimistic.etherscan.io" },
  bsc: { name: "BNB Chain", chainId: 56, explorer: "https://bscscan.com" },
  avalanche: { name: "Avalanche C-Chain", chainId: 43114, explorer: "https://snowtrace.io" },
};
/** Default stablecoins (verified mainnet contracts); override or extend with --stable. */
const DEFAULT_STABLES = {
  ethereum: [
    { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
    { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
  ],
  polygon: [
    { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", symbol: "USDC", decimals: 6 },
    { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", symbol: "USDC.e", decimals: 6 },
    { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", symbol: "USDT", decimals: 6 },
  ],
  base: [{ address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 }],
  solana: [
    { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
    { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", decimals: 6 },
  ],
};

export function parseArgs(argv) {
  const out = { chains: [], wallets: [], stables: [], dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const n = argv[++i];
      if (n === undefined || n.startsWith("--")) throw new Error(`${a} needs a value`);
      return n;
    };
    if (a === "--slug") out.slug = v();
    else if (a === "--name") out.name = v();
    else if (a === "--ticker") out.ticker = v();
    else if (a === "--coingecko") out.coingecko = v();
    else if (a === "--chain") out.chains.push(v());
    else if (a === "--wallet") out.wallets.push(v());
    else if (a === "--stable") out.stables.push(v());
    else if (a === "--root") out.root = v();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** "ethereum:0xabc:18:1:123" / "solana:MINT:6" -> project chains[] entry. */
export function chainEntry(spec, i) {
  const [key, address, decimals, chainId, deployBlock] = spec.split(":");
  if (!key || !address || decimals === undefined) throw new Error(`--chain ${spec}: use <key>:<token address>:<decimals>[:chainId[:deployBlock]]`);
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 18) throw new Error(`--chain ${spec}: decimals must be 0-18`);
  if (key === "solana") {
    if (!isSolanaAddress(address)) throw new Error(`--chain ${spec}: not a base58 mint`);
    return {
      key: "solana",
      name: "Solana",
      vm: "solana",
      cluster: "mainnet-beta",
      bridge: "native",
      ...(i === 0 ? { origin: true } : {}),
      explorer: "https://solscan.io",
      rpc: { envPrefix: "SOLANA", publicUrls: ["https://api.mainnet-beta.solana.com"] },
      tokens: [{ address, program: "spl-token", decimals: d, status: "canonical" }],
      contracts: {},
    };
  }
  if (!isEvmAddress(address)) throw new Error(`--chain ${spec}: not a 0x token address`);
  const known = KNOWN_EVM[key];
  const id = chainId ? Number(chainId) : known?.chainId;
  if (!id) throw new Error(`--chain ${spec}: unknown chain ${key}; pass the chainId`);
  return {
    key,
    name: known?.name ?? key,
    vm: "evm",
    chainId: id,
    ...(i === 0 ? { origin: true } : { bridge: "lock-mint" }),
    ...(deployBlock ? { fromBlock: Number(deployBlock) } : {}),
    ...(known?.explorer ? { explorer: known.explorer } : {}),
    tokens: [{ address: address.toLowerCase(), decimals: d, status: "canonical", ...(deployBlock ? { deployBlock: Number(deployBlock) } : {}) }],
    contracts: {},
  };
}

export function walletEntry(spec, chains) {
  const parts = spec.split(":");
  const [address, label, entityClass = "treasury"] = parts;
  if (!isEvmAddress(address) && !isSolanaAddress(address)) throw new Error(`--wallet ${spec}: bad address`);
  if (!label) throw new Error(`--wallet ${spec}: needs a label (<address>:<label>[:class])`);
  if (!["treasury", "holdings", "association"].includes(entityClass)) throw new Error(`--wallet ${spec}: class must be treasury | holdings | association`);
  const vm = isEvmAddress(address) ? "evm" : "solana";
  const a = vm === "evm" ? address.toLowerCase() : address;
  return {
    address: a,
    label,
    group: "Developer",
    entityClass,
    confidence: "medium",
    source: "add-project.js --wallet (verify before publishing)",
    chains: chains.filter((c) => (c.vm ?? "evm") === vm).map((c) => c.key),
  };
}

/** Pure: every file add-project would write, as { relPath: object }. */
export function scaffold(args, registry) {
  const slug = String(args.slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error(`--slug must match ${SLUG_RE}`);
  if (!args.name || !args.ticker) throw new Error("--name and --ticker are required");
  if (!args.chains.length) throw new Error("at least one --chain is required");
  if (registry.projects.some((p) => p.slug === slug) && !args.force) throw new Error(`${slug} is already in config/projects.json (use --force to rewrite its files)`);
  const chains = args.chains.map(chainEntry);
  const wallets = args.wallets.map((w) => walletEntry(w, chains));

  const project = {
    $comment: `Scaffolded by scripts/add-project.js on ${new Date().toISOString().slice(0, 10)}. Verify every address before publishing; see docs/MULTI-TOKEN.md "Adding the next project".`,
    slug,
    name: args.name,
    ticker: args.ticker.toUpperCase(),
    description: "",
    data: { legacyRoot: false, dir: `public/data/${slug}` },
    supply: { generationsSumOneToOne: false, ...(args.coingecko ? { coingeckoId: args.coingecko } : {}) },
    chains,
    gated: { forensics: true, walletFlows: { ...(args.coingecko ? { coingeckoId: args.coingecko } : {}), chains: chains.map((c) => c.key) } },
    // Always on: the tab shows an empty state until the first ledger run, so no per-token code edit is needed.
    capabilities: { projectWallets: true },
  };

  const stables = {};
  for (const c of chains) stables[c.key] = [...(DEFAULT_STABLES[c.key] ?? [])];
  for (const s of args.stables) {
    const [chain, address, symbol, decimals] = s.split(":");
    if (!chain || !address || !symbol || !Number.isInteger(Number(decimals))) throw new Error(`--stable ${s}: use <chain>:<address>:<symbol>:<decimals>`);
    (stables[chain] ??= []).push({ address: isEvmAddress(address) ? address.toLowerCase() : address, symbol, decimals: Number(decimals) });
  }
  const ledger = {
    $comment: `Developer-wallet ledger config for ${project.ticker}, scaffolded by scripts/add-project.js. Add relays, extra venues and a botCluster (with funding split) by hand; see docs/LEDGER.md.`,
    version: 1,
    slug,
    windows: LEDGER_WINDOWS,
    historyDays: 90,
    providers: { evm: { primary: "alchemy", method: "alchemy_getAssetTransfers", crossCheck: "etherscan" }, solana: { envKeys: ["SOLANA_RPC_0", "SOLANA_RPC_1"] } },
    chains: chains.map((c) => c.key),
    developerWallets: wallets.map(({ address, label, group, entityClass, chains: cs, confidence }) => ({ address, label, group, entityClass, chains: cs, confidence })),
    stablecoins: stables,
    venues: { useProjectCexList: true, useProjectDexList: true, projectRoles: { dex: ["dex"], staking: ["staking"] }, cex: {}, dex: {}, bridges: {}, custody: {}, staking: {} },
    relays: {},
    botCluster: null,
    trace: { maxHops: 2, stopAt: ["cex", "bridge", "developer", "custody", "known"], minUsd: 100, proceedAssets: {}, maxSales: 300 },
  };
  const walletRegistry = {
    version: 1,
    description: "Registry for the gated Wallet flows report. Scaffolded by scripts/add-project.js; add knownWallets (or run init-forensics-registry.js after tagging contracts with treasury/holdings roles).",
    knownWallets: wallets,
    botCluster: null,
    watchedSellers: [],
    extraCex: {},
    extraDex: {},
  };
  const nextRegistry = {
    ...registry,
    projects: [...registry.projects.filter((p) => p.slug !== slug), { slug, name: args.name, ticker: project.ticker }],
  };
  return {
    slug,
    files: {
      "config/projects.json": nextRegistry,
      [`config/projects/${slug}.json`]: project,
      [`config/projects/${slug}/ledger.json`]: ledger,
      [`data/${slug}/forensics/wallet-flows.registry.json`]: walletRegistry,
    },
  };
}

export function validateScaffold({ slug, files }) {
  const errors = [];
  const pc = validateProjectConfig(files[`config/projects/${slug}.json`]);
  errors.push(...pc.errors.map((e) => `project: ${e}`));
  errors.push(...validateLedgerConfig(files[`config/projects/${slug}/ledger.json`], { projectSlug: slug }).map((e) => `ledger: ${e}`));
  return { errors, warnings: pc.warnings };
}

export function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root ?? process.cwd());
  const registry = JSON.parse(fs.readFileSync(path.join(root, "config/projects.json"), "utf8"));
  const result = scaffold(args, registry);
  const { errors, warnings } = validateScaffold(result);
  for (const w of warnings) logger.warn(`warning: ${w}`);
  if (errors.length) throw new Error(`scaffold is invalid:\n  - ${errors.join("\n  - ")}`);
  for (const rel of Object.keys(result.files)) {
    if (rel === "config/projects.json") continue;
    if (fs.existsSync(path.join(root, rel)) && !args.force) throw new Error(`${rel} already exists (use --force to overwrite)`);
  }
  for (const [rel, doc] of Object.entries(result.files)) {
    logger.log(`${args.dryRun ? "would write" : "write"} ${rel}`);
    if (args.dryRun) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(doc, null, 2) + "\n");
  }
  logger.log(`\n${result.slug} scaffolded and valid. Next, by hand:
  1. Verify every address; add the token image (public/tokens/${result.slug}.<ext>) and "image" in config/projects/${result.slug}.json.
  2. Add classification.cexWallets / dexContracts files (or contracts with role "dex"/"staking").
  3. Add developer wallets (--wallet, or edit config/projects/${result.slug}/ledger.json) and a botCluster if one is known.
  4. node scripts/build-ledger.js --project ${result.slug} --dry-run
  5. npm run typecheck && npx vitest run && npm run build`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`[add-project] ${err.message}`);
    process.exit(1);
  }
}
