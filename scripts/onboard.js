#!/usr/bin/env node
/**
 * onboard.js — map a new token from its contract address or mint in one command.
 *
 *   npm run onboard -- --address <0x… | base58 mint> [--chain ethereum] [--include polygon]...
 *     [--slug foo] [--name "Foo"] [--ticker FOO] [--history-start YYYY-MM-DD]
 *     [--wallet <address>:<label>[:treasury|holdings|association]]... [--write] [--root <dir>] [--report <file>]
 *
 * Read-only discovery over free public RPC and CoinGecko's keyless API (0 Alchemy CU):
 *   decimals, symbol, name and total supply on the origin chain; the deploy block
 *   (binary search on eth_getCode) and its date; the CoinGecko id, name and image;
 *   copies on other chains (scripts/lib/tokenChains.js). Other chains found are
 *   recorded as excluded with a reason unless --include names them.
 * Then runs scripts/add-project.js with every flag filled: a dry run by default,
 * files written with --write (plus the token image into public/tokens/). Never
 * commits, never touches public/data.
 *
 * What it cannot decide (the onboard-project skill does): staking, treasury/team
 * wallets, top-holder tracing, DEX pools, the Solana CEX list. After the files
 * are reviewed and merged to main, one dispatch finishes the first data:
 *   gh workflow run onboard-project.yml -f project=<slug>
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { coingeckoPlatformFor, findDeployBlock, inferVm, planOnboarding } from "./lib/onboard.js";
import { CANDIDATE_CHAINS } from "./lib/tokenChains.js";

const SELECTOR = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" };

export function parseArgs(argv) {
  const out = { include: [], wallets: [], write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const n = argv[++i];
      if (n === undefined || n.startsWith("--")) throw new Error(`${a} needs a value`);
      return n;
    };
    if (a === "--address") out.address = v().trim();
    else if (a === "--chain") out.chain = v().toLowerCase();
    else if (a === "--include") out.include.push(v().toLowerCase());
    else if (a === "--slug") out.slug = v();
    else if (a === "--name") out.name = v();
    else if (a === "--ticker") out.ticker = v();
    else if (a === "--history-start") out.historyStart = v();
    else if (a === "--wallet") out.wallets.push(v());
    else if (a === "--root") out.root = v();
    else if (a === "--report") out.report = v();
    else if (a === "--write") out.write = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.address) throw new Error("--address <contract or mint> is required");
  return out;
}

async function evmFacts(chain, address) {
  const { getPublicFallbackUrls, rpcCall } = await import("./lib/rpc.js");
  const { decodeAbiString } = await import("./lib/tokenChains.js");
  const urls = getPublicFallbackUrls(chain);
  if (!urls.length) throw new Error(`${chain}: no public RPC configured (scripts/lib/rpc.js)`);
  const call = async (method, params) => {
    let last;
    for (const url of urls) {
      try {
        return await rpcCall(url, method, params);
      } catch (error) {
        last = error;
      }
    }
    throw last;
  };
  const read = (data, block = "latest") => call("eth_call", [{ to: address, data }, block]);
  const code = await call("eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || code === "0x") throw new Error(`${chain}: no contract at ${address}`);
  // One at a time: free public nodes rate-limit bursts. name/symbol are optional on old tokens; decimals and supply are not.
  const name = await read(SELECTOR.name).catch(() => null);
  const symbol = await read(SELECTOR.symbol).catch(() => null);
  const decimals = await read(SELECTOR.decimals);
  const supply = await read(SELECTOR.totalSupply);
  const latest = Number(BigInt(await call("eth_blockNumber", [])));
  const hasCode = async (block) => {
    const c = await call("eth_getCode", [address, `0x${block.toString(16)}`]);
    return typeof c === "string" && c !== "0x";
  };
  const deployBlock = await findDeployBlock({ latest, hasCode }).catch(() => null);
  let deployDate = null;
  if (deployBlock != null) {
    const b = await call("eth_getBlockByNumber", [`0x${deployBlock.toString(16)}`, false]).catch(() => null);
    if (b?.timestamp) deployDate = new Date(Number(BigInt(b.timestamp)) * 1000).toISOString().slice(0, 10);
  }
  return {
    name: decodeAbiString(name),
    symbol: decodeAbiString(symbol),
    decimals: decimals && decimals !== "0x" ? Number(BigInt(decimals)) : null,
    totalSupplyRaw: supply && supply !== "0x" ? BigInt(supply).toString() : null,
    deployBlock,
    deployDate,
  };
}

async function solanaFacts(mint) {
  const { getUsableSolanaRpcUrls, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
  const { fetchMintMetadata } = await import("./lib/solana/metadata.js");
  const urls = await getUsableSolanaRpcUrls("solana", { logger: { log() {}, warn() {} } });
  const call = (m, p) => solanaCallWithFailover(urls, m, p, { chainKey: "solana" });
  const meta = await fetchMintMetadata(call, mint);
  const supply = await call("getTokenSupply", [mint, { commitment: "finalized" }]);
  return { name: meta.name ?? null, symbol: meta.symbol ?? null, decimals: meta.decimals, totalSupplyRaw: supply?.value?.amount ?? null, deployBlock: null, deployDate: null };
}

async function coingeckoListing(chain, address) {
  const platform = coingeckoPlatformFor(chain);
  if (!platform) return null;
  const id = chain === "solana" ? address : address.toLowerCase();
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${id}`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return { id: body.id ?? null, name: body.name ?? null, symbol: body.symbol ?? null, image: body.image?.large ?? null, platforms: body.platforms ?? {} };
  } catch {
    return null;
  }
}

async function discoverChains(chain, address, ticker) {
  const { getPublicFallbackUrls, rpcCall } = await import("./lib/rpc.js");
  const { detectTokenChains } = await import("./lib/tokenChains.js");
  const config = { ticker, chains: [{ key: chain, ...(chain === "solana" ? { vm: "solana" } : {}), origin: true, tokens: [{ address, status: "canonical" }] }] };
  return detectTokenChains({ config, call: rpcCall, urlsFor: (key) => getPublicFallbackUrls(key), useCoingecko: true });
}

async function downloadImage(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`token image ${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

export async function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root ?? process.cwd());
  const vm = inferVm(args.address);
  if (vm === "hedera") throw new Error("Hedera (0.0.N) validates and scaffolds but is not onboardable yet: its supply file, cutoffs, history, CEX list and staking are not built (tasks/hedera-plan.md)");
  if (!vm) throw new Error(`unsupported address ${args.address}: expected a 0x EVM contract or a base58 Solana mint`);
  const chain = args.chain ?? (vm === "solana" ? "solana" : "ethereum");
  if (vm === "evm" && !CANDIDATE_CHAINS.some((c) => c.key === chain)) throw new Error(`--chain ${chain}: not an EVM chain this repo can scan (${CANDIDATE_CHAINS.map((c) => c.key).join(", ")})`);

  logger.log(`Discovery for ${args.address} on ${chain} (public RPC, keyless CoinGecko)...`);
  const facts = vm === "solana" ? await solanaFacts(args.address) : await evmFacts(chain, args.address);
  const coingecko = await coingeckoListing(chain, args.address);
  const discovery = await discoverChains(chain, args.address, args.ticker ?? facts.symbol ?? coingecko?.symbol ?? "");
  const included = {};
  for (const key of args.include) {
    const row = discovery.chains.find((r) => r.chain === key && (r.status === "candidate" || r.status === "listed-unverified"));
    if (!row?.address || !Number.isInteger(row.decimals)) throw new Error(`--include ${key}: no verified copy of the token on ${key} in discovery`);
    included[key] = { address: row.address, decimals: row.decimals };
  }

  const plan = planOnboarding({
    address: args.address,
    chain,
    facts,
    coingecko,
    discovery,
    included,
    overrides: { slug: args.slug, name: args.name, ticker: args.ticker, historyStart: args.historyStart, wallets: args.wallets },
  });

  logger.log(`\n  slug ${plan.slug}  name ${plan.name}  ticker ${plan.ticker}  vm ${plan.vm}`);
  logger.log(`  decimals ${facts.decimals}  supply.target ${plan.supplyTarget.toLocaleString("en-US")}`);
  logger.log(`  deploy block ${facts.deployBlock ?? "unknown"}  history start ${plan.historyStart ?? "unset"}`);
  logger.log(`  coingecko ${coingecko?.id ?? "not listed"}  image ${plan.image?.path ?? "none"}`);
  logger.log(`  chains: ${plan.inventory.chains.map((r) => `${r.chain}=${r.status}`).join(", ")}`);
  for (const n of plan.notes) logger.log(`  note: ${n}`);

  const invFile = path.join(root, "tasks", `onboard-${plan.slug}-inventory.json`);
  fs.mkdirSync(path.dirname(invFile), { recursive: true });
  fs.writeFileSync(invFile, `${JSON.stringify(plan.inventory, null, 2)}\n`);
  if (args.report) fs.writeFileSync(path.resolve(args.report), `${JSON.stringify({ facts, coingecko, discovery, plan }, null, 2)}\n`);

  const { main: addProject } = await import("./add-project.js");
  logger.log(`\nnode scripts/add-project.js ${plan.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")} --inventory ${path.relative(root, invFile)}${args.write ? "" : " --dry-run"}`);
  addProject([...plan.argv, "--inventory", invFile, "--root", root, ...(args.write ? [] : ["--dry-run"])], { logger });

  if (args.write && plan.vm === "evm") {
    const rel = `config/projects/${plan.slug}/cex-wallets.json`;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ wallets: [] }, null, 2)}\n`);
    const cfgFile = path.join(root, "config/projects", `${plan.slug}.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    cfg.classification = { ...cfg.classification, cexWallets: rel };
    fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    logger.log(`write ${rel} (empty; sync-cex-wallets.yml fills it from Dune's public spellbook list)`);
  }
  if (args.write && plan.image) {
    await downloadImage(plan.image.url, path.join(root, "public", plan.image.path));
    logger.log(`write public${plan.image.path}`);
  }

  logger.log(`\nNext (onboard-project skill, steps 2-3 and 5): decide staking, treasury/team wallets, DEX pools${plan.vm === "solana" ? ", the CEX list" : ""};
add docs/${plan.slug}-wallet-candidates.md for large unlabelled holders after the first snapshot; then open the PR (README update).
After it is merged to main: gh workflow run onboard-project.yml -f project=${plan.slug}`);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[onboard] ${err.message}`);
    process.exit(1);
  });
}
