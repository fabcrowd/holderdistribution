#!/usr/bin/env node
/**
 * onboard.js — map a new token from its contract address or mint in one command.
 *
 *   npm run onboard -- --address <0x… | base58 mint> [--chain ethereum] [--include polygon]...
 *     [--slug foo] [--name "Foo"] [--ticker FOO] [--history-start YYYY-MM-DD]
 *     [--wallet <address>:<label>[:class]]... [--answers <file>] [--answers-out <file>]
 *     [--write] [--root <dir>] [--report <file>]
 *
 * Two steps (the owner's judgement lives in ONE validated file, scripts/lib/onboardAnswers.js):
 *   1. dry run: discovery + a pre-filled answers TEMPLATE at tasks/onboard-<slug>.answers.json
 *      (or --answers-out). Writes nothing tracked.
 *   2. fill every FILL_ME (staking, wallets, DEX pools, CEX list, history start), then
 *      npm run onboard -- --address <addr> --answers <file> --write
 *      which validates the answers and expands them into every config file in one pass
 *      (re-running it for an existing slug merges them idempotently; no --force).
 *   --write without --answers is refused (except the hedera native coin, whose classification
 *   comes from its chain adapter).
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
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chainFromProbe, coingeckoPlatformFor, findDeployBlock, inferVm, planOnboarding, probeEvmChain } from "./lib/onboard.js";
import { FORWARD_ONLY, answersTemplateRelPath, assertAnswers, assertWritable, buildAnswersTemplate, writeBlockers } from "./lib/onboardAnswers.js";
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
    else if (a === "--answers") out.answers = v();
    else if (a === "--answers-out") out.answersOut = v();
    else if (a === "--coingecko") out.coingecko = v();
    else if (a === "--write") out.write = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (Object.hasOwn(NATIVE_CHAINS, out.chain ?? "")) out.address ??= "native";
  if (!out.address && !out.answers) throw new Error("--address <contract or mint> is required (or --chain hedera for HBAR itself, or --answers <file> which carries the address)");
  return out;
}

/** Chains whose own coin can be onboarded (no contract): adapter vm and default CoinGecko id. */
const NATIVE_CHAINS = { hedera: { vm: "hedera", coingecko: "hedera-hashgraph" } };

async function nativeFacts(chain) {
  const { loadChainAdapter } = await import("./lib/chainAdapters.js");
  const meta = await (await loadChainAdapter(NATIVE_CHAINS[chain].vm)).tokenMeta({ key: chain }, null);
  return { name: meta.name, symbol: meta.symbol, decimals: meta.decimals, totalSupplyRaw: meta.supplyRaw.toString(), deployBlock: null, deployDate: null };
}

async function coingeckoCoin(id) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return { id: body.id ?? id, name: body.name ?? null, symbol: body.symbol ?? null, image: body.image?.large ?? null, platforms: body.platforms ?? {} };
  } catch {
    return null;
  }
}

async function evmFacts(chain, address) {
  const { getPublicFallbackUrls, rpcCall } = await import("./lib/rpc.js");
  const { decodeAbiString } = await import("./lib/tokenChains.js");
  const urls = getPublicFallbackUrls(chain);
  const rpcHint = `set PUBLIC_RPC_URLS_${chain.toUpperCase()}=<rpc url> to use another node`;
  if (!urls.length) throw new Error(`${chain}: no public RPC configured (scripts/lib/rpc.js); ${rpcHint}`);
  const call = async (method, params) => {
    let last;
    for (const url of urls) {
      try {
        return await rpcCall(url, method, params);
      } catch (error) {
        last = error;
      }
    }
    throw new Error(`${chain}: ${last?.message ?? last} (every public RPC failed; ${rpcHint})`);
  };
  const read = (data, block = "latest") => call("eth_call", [{ to: address, data }, block]);
  const code = await call("eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || code === "0x") throw new Error(`${chain}: no contract at ${address}. Wrong chain? Pass --chain <${CANDIDATE_CHAINS.map((c) => c.key).join("|")}>, or omit --chain to probe every chain`);
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
  const call = async (m, p) => {
    try {
      return await solanaCallWithFailover(urls, m, p, { chainKey: "solana" });
    } catch (error) {
      throw new Error(`solana: ${error.message} (set PUBLIC_RPC_URLS_SOLANA=<rpc url> to use another node)`);
    }
  };
  const meta = await fetchMintMetadata(call, mint);
  const supply = await call("getTokenSupply", [mint, { commitment: "finalized" }]);
  // meta.program is read from the mint account's owner (spl-token or token-2022), so it is never guessed.
  return { name: meta.name ?? null, symbol: meta.symbol ?? null, decimals: meta.decimals, totalSupplyRaw: supply?.value?.amount ?? null, deployBlock: null, deployDate: null, program: meta.program };
}

/** EVM origin chain when --chain is omitted: probe every candidate chain sequentially. */
async function resolveEvmChain(address, logger) {
  const { getPublicFallbackUrls, rpcCall } = await import("./lib/rpc.js");
  const hasCode = async (chain) => {
    const urls = getPublicFallbackUrls(chain);
    if (!urls.length) throw new Error("no public RPC configured");
    let last;
    for (const url of urls) {
      try {
        const code = await rpcCall(url, "eth_getCode", [address, "latest"]);
        return typeof code === "string" && code !== "0x";
      } catch (error) {
        last = error;
      }
    }
    throw last;
  };
  logger.log(`--chain not given: looking for code at ${address} on each EVM chain, one at a time...`);
  const probe = await probeEvmChain({ chains: CANDIDATE_CHAINS.map((c) => c.key), hasCode });
  const chain = chainFromProbe(probe, address);
  if (chain instanceof Error) throw chain;
  if (probe.failed.length) logger.log(`  not checked (RPC error): ${probe.failed.map((f) => f.chain).join(", ")}; if the token is also on one of them pass --chain explicitly`);
  return chain;
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

/**
 * The native coin has no answers file, whose wallets section is what fills the forensics registry and the ledger wallets
 * for every other token, so the scaffold derives them here from the classification it just wrote (init-forensics-registry.js).
 * A registry that already lists wallets is left alone (re-running must not drop hand edits; use init-forensics-registry.js --force).
 */
async function initForensicsRegistry(slug, root, logger) {
  const file = path.join(root, `data/${slug}/forensics/wallet-flows.registry.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  if ((existing?.knownWallets ?? []).length > 0) {
    logger.log(`forensics registry ${path.relative(root, file).split(path.sep).join("/")} already lists ${existing.knownWallets.length} wallets: kept`);
    return;
  }
  const { resolveProject } = await import("./lib/projects.js");
  const { writeRegistry } = await import("./init-forensics-registry.js");
  const result = await writeRegistry(resolveProject(slug, root), { root, force: true });
  logger.log(`write ${path.relative(root, result.path).split(path.sep).join("/")}: ${result.wallets} wallets (and ${result.ledgerWallets} ledger wallet rows synced)`);
}

export async function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root ?? process.cwd());
  let answers = null;
  if (args.answers) {
    answers = assertAnswers(JSON.parse(fs.readFileSync(path.resolve(args.answers), "utf8")), args.answers);
    const same = (a, b) => (/^0x/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (args.address && !same(args.address, answers.address)) throw new Error(`--address ${args.address} is not the answers file's address ${answers.address}: the file belongs to a different token`);
    if (args.chain && args.chain !== answers.chain) throw new Error(`--chain ${args.chain} is not the answers file's chain ${answers.chain}`);
    if (args.wallets.length) throw new Error("--wallet cannot be combined with --answers: put the wallet in the answers file's wallets[]");
    if (args.historyStart) throw new Error("--history-start cannot be combined with --answers: set historyStart in the answers file");
    args.address = answers.address;
    args.chain = answers.chain;
    args.include = [...new Set([...args.include, ...answers.include])];
    args.slug ??= answers.slug;
    args.name ??= answers.name;
    args.ticker ??= answers.ticker;
    args.historyStart = answers.historyStart === FORWARD_ONLY ? null : answers.historyStart;
    if (args.write) assertWritable(answers, args.answers);
    else for (const b of writeBlockers(answers)) logger.warn(`warning: --write will refuse these answers: ${b}`);
  }
  const native = args.address === "native" && Object.hasOwn(NATIVE_CHAINS, args.chain ?? "") ? NATIVE_CHAINS[args.chain] : null;
  if (args.write && !answers && !native) {
    throw new Error(
      "--write needs the owner's answers file (staking, wallets, DEX pools, CEX list and history start are decided there, never skipped).\n" +
        `  1. npm run onboard -- --address ${args.address}      (dry run: prints discovery, writes tasks/onboard-<slug>.answers.json)\n` +
        "  2. fill every FILL_ME in that file (each decision needs evidence)\n" +
        `  3. npm run onboard -- --address ${args.address} --answers tasks/onboard-<slug>.answers.json --write`,
    );
  }
  const vm = native ? native.vm : inferVm(args.address);
  if (!native && vm === "hedera") throw new Error("0.0.N is a Hedera token (HTS) or account: HTS tokens are not supported yet. For HBAR itself use --chain hedera");
  if (!vm) throw new Error(`unsupported address ${args.address}: expected a 0x EVM contract, a base58 Solana mint, or --chain hedera`);
  const chain = args.chain ?? (vm === "solana" ? "solana" : await resolveEvmChain(args.address, logger));
  if (vm === "evm" && !CANDIDATE_CHAINS.some((c) => c.key === chain)) throw new Error(`--chain ${chain}: not an EVM chain this repo can scan (${CANDIDATE_CHAINS.map((c) => c.key).join(", ")})`);

  logger.log(`Discovery for ${native ? `the ${chain} native coin` : args.address} on ${chain} (public node, keyless CoinGecko)...`);
  const facts = native ? await nativeFacts(chain) : vm === "solana" ? await solanaFacts(args.address) : await evmFacts(chain, args.address);
  const coingecko = native ? await coingeckoCoin(args.coingecko ?? native.coingecko) : await coingeckoListing(chain, args.address);
  // A native coin has no contract to look for on other chains.
  const discovery = native ? { chains: [] } : await discoverChains(chain, args.address, args.ticker ?? facts.symbol ?? coingecko?.symbol ?? "");
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
  logger.log(`  deploy block ${facts.deployBlock ?? "unknown"}  history start ${plan.historyStart ?? (answers || plan.vm !== "evm" ? FORWARD_ONLY : "unset")}${facts.program ? `  token program ${facts.program}` : ""}`);
  logger.log(`  coingecko ${coingecko?.id ?? "not listed"}  image ${plan.image?.path ?? "none"}`);
  logger.log(`  chains: ${plan.inventory.chains.map((r) => `${r.chain}=${r.status}`).join(", ")}`);
  for (const n of plan.notes) logger.log(`  note: ${n}`);

  if (args.report) fs.writeFileSync(path.resolve(args.report), `${JSON.stringify({ facts, coingecko, discovery, plan }, null, 2)}\n`);

  let templateFile = null;
  // The native coin has no answers file: its owner decisions come from the chain adapter, so there is no template to fill.
  if (!answers && !native) {
    // A dry run writes nothing tracked: the template goes to tasks/ (gitignored) or --answers-out.
    templateFile = path.resolve(args.answersOut ?? path.join(root, answersTemplateRelPath(plan.slug)));
    const includeCandidates = discovery.chains.filter((r) => (r.status === "candidate" || r.status === "listed-unverified") && r.address).map((r) => `${r.chain} ${r.address}`);
    const template = buildAnswersTemplate({
      address: args.address,
      chain,
      slug: plan.slug,
      name: plan.name,
      ticker: plan.ticker,
      includeCandidates,
      historyStart: args.historyStart ?? facts.deployDate ?? (plan.vm === "evm" ? null : FORWARD_ONLY),
    });
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(templateFile, `${JSON.stringify(template, null, 2)}\n`);
  }

  // The inventory is only an input of add-project, which copies it into config/projects/<slug>/: keep the temp copy out of the repo.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `onboard-${plan.slug}-`));
  const invFile = path.join(tmpDir, `${plan.slug}-inventory.json`);
  fs.writeFileSync(invFile, `${JSON.stringify(plan.inventory, null, 2)}\n`);
  const { main: addProject } = await import("./add-project.js");
  const answersArgs = answers ? ["--answers", path.resolve(args.answers)] : [];
  // The native coin has no answers file to re-apply, so a second run re-applies its classification only (idempotent, byte-stable).
  const registered = JSON.parse(fs.readFileSync(path.join(root, "config/projects.json"), "utf8")).projects.some((p) => p.slug === plan.slug);
  const rescaffold = Boolean(native && !answers && registered);
  try {
    if (rescaffold) {
      logger.log(`\n${plan.slug} is already scaffolded: re-applying the ${chain} network classification only.`);
    } else {
      logger.log(`\nnode scripts/add-project.js ${[...plan.argv, ...answersArgs].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")} --inventory <temp>${args.write ? "" : " --dry-run"}`);
      addProject([...plan.argv, ...answersArgs, ...(native ? ["--native-coin"] : []), "--inventory", invFile, "--root", root, ...(args.write ? [] : ["--dry-run"])], { logger });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // The native-coin classification rewrites exclusions.json wholesale, so it only runs on the old no-answers path.
  if (native && !answers) {
    const { loadChainAdapter } = await import("./lib/chainAdapters.js");
    const cls = await (await loadChainAdapter(native.vm)).nativeClassification?.();
    if (cls) {
      logger.log(`${args.write ? "apply" : "would apply"} ${chain} network classification: ${cls.exclusions.addresses.length} treasury accounts, ${cls.cexWallets?.wallets.length ?? 0} CEX accounts, contracts ${Object.entries(cls.contracts).map(([k, c]) => `${k}=${c.address}(${c.role})`).join(", ")}, treasury.categories ${JSON.stringify(cls.treasuryCategories)}, workflowTimeoutMinutes ${cls.workflowTimeoutMinutes}, holdersScanTimeoutMinutes ${cls.holdersScanTimeoutMinutes ?? "default"}`);
      if (args.write) {
        fs.writeFileSync(path.join(root, `config/projects/${plan.slug}/exclusions.json`), `${JSON.stringify(cls.exclusions, null, 2)}\n`);
        const cfgFile = path.join(root, "config/projects", `${plan.slug}.json`);
        const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
        cfg.chains = cfg.chains.map((c) => (c.key === chain ? { ...c, contracts: { ...c.contracts, ...cls.contracts } } : c));
        cfg.treasury = { ...cfg.treasury, categories: cls.treasuryCategories };
        if (cls.circulatingSubtract) cfg.supply = { ...cfg.supply, circulating: { ...cfg.supply?.circulating, subtract: cls.circulatingSubtract } };
        if (cls.nightlyWaivers) cfg.nightly = { ...cfg.nightly, waivers: { ...cfg.nightly?.waivers, ...cls.nightlyWaivers } };
        if (cls.cexWallets) {
          const rel = `config/projects/${plan.slug}/cex-wallets.json`;
          fs.writeFileSync(path.join(root, rel), `${JSON.stringify(cls.cexWallets, null, 2)}\n`);
          cfg.classification = { ...cfg.classification, cexWallets: rel };
        }
        cfg.pipeline = {
          ...cfg.pipeline,
          workflowTimeoutMinutes: cls.workflowTimeoutMinutes,
          ...(cls.holdersScanTimeoutMinutes ? { holdersScanTimeoutMinutes: cls.holdersScanTimeoutMinutes } : {}),
        };
        fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
        await initForensicsRegistry(plan.slug, root, logger);
      }
    }
  }
  if (args.write && plan.image && !fs.existsSync(path.join(root, "public", plan.image.path))) {
    await downloadImage(plan.image.url, path.join(root, "public", plan.image.path));
    logger.log(`write public${plan.image.path}`);
  }

  // The effective command: --root is carried so the next run reads and writes the same directory.
  const rootArg = args.root ? ` --root ${root}` : "";
  if (templateFile) {
    logger.log(`\nWrote the answers template ${templateFile} (nothing tracked was written).
Next: fill every FILL_ME in it (staking, wallets, DEX pools, CEX list; each decision needs evidence), then run:
  npm run onboard -- --address ${args.address} --answers ${templateFile}${rootArg} --write`);
  } else if (native && !answers) {
    logger.log(args.write ? `\n${chain} native coin scaffolded from its chain adapter (no answers file). Next: the steps printed above.` : `\nDry run: nothing written. Run the same command with --write to scaffold the ${chain} native coin.`);
  } else if (!args.write) {
    logger.log(`\nAnswers are valid. Next: run the same command with --write to expand them into ${path.join(root, "config/projects", plan.slug)} (onboarding.answers.json there keeps the record):
  npm run onboard -- --address ${args.address} --answers ${args.answers}${rootArg} --write`);
  }
  // After --write, add-project.js has already printed the next steps (tests, diff, merge, dispatch, onboard:check).
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[onboard] ${err.message}`);
    process.exit(1);
  });
}
