#!/usr/bin/env node
/**
 * add-project.js — scaffold a new mapped project in one command, then validate it.
 *
 *   node scripts/add-project.js --slug foo --name "Foo Network" --ticker FOO \
 *     --chain ethereum:0xTOKEN:18[:chainId[:deployBlock]] [--chain solana:MINT:6] \
 *     [--wallet <address>:<label>[:treasury|holdings|association]] ... \
 *     --inventory chains-inventory.json \
 *     [--coingecko foo-network] [--stable ethereum:0xUSDC:USDC:6] [--dry-run] [--force] [--root <dir>]
 *     [--supply-target <whole tokens>] [--image /tokens/<slug>.<ext>] [--history-start YYYY-MM-DD]
 *     [--answers <onboarding.answers.json>]   expand the owner's validated answers (scripts/lib/onboardAnswers.js)
 *
 * With --answers for an already-registered slug, the answers are merged into the existing files
 * idempotently (no --force). --force rewrites every scaffold file and needs env ONBOARD_FORCE=<slug>.
 *
 * scripts/onboard.js runs discovery and then this scaffold with every flag filled.
 * The registry entry is written with `onboarding: true` (pipeline runs it, the site
 * does not list it); scripts/onboard-run.js removes the flag once check-go-live passes.
 *
 * --inventory is required (onboarding step 1, chain & contract discovery; see
 * scripts/lib/chainInventory.js): every --chain must be in it as "configured",
 * and every other chain it lists must be "excluded"/"not-found" with a reason.
 *
 * Writes (refuses to overwrite without --force):
 *   config/projects.json                                   + registry entry (appended)
 *   config/projects/<slug>.json                            project config
 *   config/projects/<slug>/ledger.json                     developer-wallet ledger config
 *   data/<slug>/forensics/wallet-flows.registry.json       wallet registry (empty unless --wallet given)
 *   config/projects/<slug>/chains-inventory.json           the validated --inventory
 *
 * Then validates the project config (scripts/lib/projects.js) and the ledger
 * config (scripts/lib/ledger/config.js) and prints the next steps (tests, diff, merge,
 * dispatch, onboard:check) and what is still manual. Never touches public/data and never commits.
 * Answers that validate but cannot be written yet (staking "unresolved") are refused without --dry-run.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { SLUG_RE, validateProjectConfig } from "./lib/projects.js";
import { canonicalAddressForVm } from "./lib/address.js";
import { isEvmAddress, isSolanaAddress, LEDGER_WINDOWS, validateLedgerConfig, walletAddressVm } from "./lib/ledger/config.js";
import { nightlyPlan } from "./lib/nightlyPlan.js";
import { inventoryRelPath, validateInventory } from "./lib/chainInventory.js";
import { MEGA_SUPPLY_DIVISOR } from "./lib/deriveHolderTiers.js";
import { loadDefaultHolderTiersRaw } from "./lib/holderTiers.js";
import { WALLET_CLASSES, applyAnswers, assertAnswers, assertWritable, readProjectFiles, writeProjectFiles } from "./lib/onboardAnswers.js";

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
    else if (a === "--supply-target") out.supplyTarget = Number(v());
    else if (a === "--image") out.image = v();
    else if (a === "--history-start") out.historyStart = v();
    else if (a === "--chain") out.chains.push(v());
    else if (a === "--wallet") out.wallets.push(v());
    else if (a === "--stable") out.stables.push(v());
    else if (a === "--root") out.root = v();
    else if (a === "--inventory") out.inventory = v();
    else if (a === "--answers") out.answersFile = v();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--native-coin") out.nativeCoin = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** "ethereum:0xabc:18:1:123" / "solana:MINT:6[:token-2022]" -> project chains[] entry. */
export function chainEntry(spec, i) {
  const [key, address, decimals, chainId, deployBlock] = spec.split(":");
  if (!key || !address || decimals === undefined) throw new Error(`--chain ${spec}: use <key>:<token address>:<decimals>[:chainId[:deployBlock]]`);
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 18) throw new Error(`--chain ${spec}: decimals must be 0-18`);
  if (key === "hedera") {
    if (address !== "native") throw new Error(`--chain ${spec}: hedera is the native coin; use hedera:native:<decimals>`);
    return { key: "hedera", name: "Hedera", vm: "hedera", bridge: "native", ...(i === 0 ? { origin: true } : {}), asset: { kind: "native", decimals: d }, contracts: {} };
  }
  if (key === "solana") {
    if (!isSolanaAddress(address)) throw new Error(`--chain ${spec}: not a base58 mint`);
    // On Solana the 4th segment is the token program (the EVM chainId slot is unused).
    if (chainId !== undefined && chainId !== "" && !["spl-token", "token-2022"].includes(chainId)) throw new Error(`--chain ${spec}: the 4th segment of a Solana spec is the token program: spl-token | token-2022`);
    return {
      key: "solana",
      name: "Solana",
      vm: "solana",
      cluster: "mainnet-beta",
      bridge: "native",
      ...(i === 0 ? { origin: true } : {}),
      explorer: "https://solscan.io",
      rpc: { envPrefix: "SOLANA", publicUrls: ["https://api.mainnet-beta.solana.com"] },
      tokens: [{ address, program: chainId || "spl-token", decimals: d, status: "canonical" }],
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
  const vm = walletAddressVm(address);
  if (!vm) throw new Error(`--wallet ${spec}: bad address`);
  // A 0.0.N id is only an address on a project that has a Hedera chain; elsewhere it is neither EVM nor Solana, so it fails loudly.
  if (vm === "hedera" && !chains.some((c) => c.vm === "hedera")) throw new Error(`--wallet ${spec}: bad address (a Hedera id needs a project with a hedera chain)`);
  if (!label) throw new Error(`--wallet ${spec}: needs a label (<address>:<label>[:class])`);
  if (!WALLET_CLASSES.includes(entityClass)) throw new Error(`--wallet ${spec}: class must be ${WALLET_CLASSES.join(" | ")}`);
  const a = canonicalAddressForVm(vm, address);
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

/**
 * The first holders block: megaHolderThreshold = supply.target / 5. On a tiny supply that is at or below the shared default
 * retailThreshold (normalizeHolderTiers then throws: mega must exceed retail), so retailThreshold is written too, at half of
 * mega. The runner derives the real retailThreshold from the first snapshot and replaces it.
 */
export function scaffoldHolders(supplyTarget) {
  const megaHolderThreshold = supplyTarget / MEGA_SUPPLY_DIVISOR;
  return megaHolderThreshold > loadDefaultHolderTiersRaw().retailThreshold ? { megaHolderThreshold } : { megaHolderThreshold, retailThreshold: megaHolderThreshold / 2 };
}

/** Pure: every file add-project would write, as { relPath: object }. */
export function scaffold(args, registry) {
  const slug = String(args.slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error(`--slug must match ${SLUG_RE}`);
  if (!args.name || !args.ticker) throw new Error("--name and --ticker are required");
  if (!args.chains.length) throw new Error("at least one --chain is required");
  if (registry.projects.some((p) => p.slug === slug) && !args.force) throw new Error(`${slug} is already in config/projects.json. To change owner decisions re-run with --answers <file> (merges them without touching hand edits). --force rewrites every scaffold file and drops hand edits (needs env ONBOARD_FORCE=${slug}).`);
  const chains = args.chains.map(chainEntry);
  const cliWallets = args.wallets.map((w) => walletEntry(w, chains));
  if (args.supplyTarget !== undefined && !(Number.isFinite(args.supplyTarget) && args.supplyTarget > 0)) throw new Error("--supply-target must be a positive number of whole tokens");
  if (args.image !== undefined && !/^\/tokens\/[a-z0-9-]+\.(png|jpg|jpeg|svg|webp)$/.test(args.image)) throw new Error("--image must be /tokens/<slug>.<png|jpg|jpeg|svg|webp>");
  if (args.historyStart !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.historyStart)) throw new Error("--history-start must be YYYY-MM-DD");
  const project = {
    $comment: `Scaffolded by scripts/add-project.js on ${new Date().toISOString().slice(0, 10)}. Verify every address before publishing; see docs/MULTI-TOKEN.md "Adding the next project".`,
    slug,
    name: args.name,
    ticker: args.ticker.toUpperCase(),
    description: "",
    ...(args.image ? { image: args.image } : {}),
    data: { legacyRoot: false, dir: `public/data/${slug}` },
    supply: {
      ...(args.supplyTarget ? { target: args.supplyTarget } : {}),
      generationsSumOneToOne: false,
      ...(args.coingecko ? { coingeckoId: args.coingecko } : {}),
    },
    // A new token's first snapshot must not run on the TEL-sized shared default (20B): a wallet above this cut that is not
    // labelled is dropped from holderCount and retail. Tiers stay absent until the runner derives them from the snapshot;
    // the runner then raises this value above the owner's acknowledged-retail large holders (lib/onboardRun.js megaThresholdFor).
    ...(args.supplyTarget ? { holders: scaffoldHolders(args.supplyTarget) } : {}),
    chains,
    // No staking until discovery finds a mechanism (a staking[] entry then re-enables the staker feed).
    staking: [],
    // applyAnswers lists only the buckets a wallet fills (append-treasury-history aborts on a listed category with no balance).
    treasury: { categories: [] },
    health: { feeds: { "funding-wallets.json": { disabled: true } } },
    ...(args.historyStart ? { pipeline: { historyStart: args.historyStart } } : {}),
    gated: { forensics: true, walletFlows: { ...(args.coingecko ? { coingeckoId: args.coingecko } : {}), chains: chains.map((c) => c.key) } },
    // Off until the first ledger report is committed: a live project never shows an empty tab.
    capabilities: { projectWallets: false },
    // Every token needs its own exclusions file: it labels the ledger's association wallets
    // (else they count as retail; scripts/lib/associationWalletsLabelled.test.js) and never inherits TEL's.
    classification: { exclusions: `config/projects/${slug}/exclusions.json` },
    // Parity by default: every job in config/nightly-jobs.json that this project's
    // chains support runs nightly. Opt out only with a reason:
    //   "nightly": { "waivers": { "<jobId>": "why this job cannot apply" } }
    nightly: { waivers: {} },
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
    developerWallets: [],
    stablecoins: stables,
    venues: { useProjectCexList: true, useProjectDexList: true, projectRoles: { dex: ["dex"], staking: ["staking"] }, cex: {}, dex: {}, bridges: {}, custody: {}, staking: {} },
    relays: {},
    botCluster: null,
    trace: { maxHops: 2, stopAt: ["cex", "bridge", "developer", "custody", "known"], minUsd: 100, proceedAssets: {}, maxSales: 300 },
  };
  const exclusions = {
    $comment: `Classification labels for ${project.ticker}, scaffolded by scripts/add-project.js. Association wallets from onboarding.answers.json are labelled here (category treasury, evidenceTier owner-supplied); label any other non-retail holder not already in a contracts{} role by hand. See docs/MULTI-TOKEN.md.`,
    addresses: [],
    labels: {},
  };
  const walletRegistry = {
    version: 1,
    description: "Registry for the gated Wallet flows report. Scaffolded by scripts/add-project.js; knownWallets come from onboarding.answers.json (or --wallet).",
    knownWallets: [],
    botCluster: null,
    watchedSellers: [],
    extraCex: {},
    extraDex: {},
  };
  const nextRegistry = {
    ...registry,
    // Off the landing page and sitemap until scripts/onboard-run.js sees check-go-live pass.
    projects: [...registry.projects.filter((p) => p.slug !== slug), { slug, name: args.name, ticker: project.ticker, onboarding: true }],
  };
  const files = {
    "config/projects.json": nextRegistry,
    [`config/projects/${slug}.json`]: project,
    [`config/projects/${slug}/ledger.json`]: ledger,
    [`config/projects/${slug}/exclusions.json`]: exclusions,
    [`data/${slug}/forensics/wallet-flows.registry.json`]: walletRegistry,
  };
  if (args.answers) return { slug, files: applyAnswers(files, args.answers, { slug }) };
  // --wallet: one answers-wallet per configured chain of the wallet's vm, through the same expansion
  // (contracts{} role, exclusions label, ledger, registry, categories) so it is never left counted as retail.
  const wallets = cliWallets.flatMap((w) => w.chains.map((chain) => ({ chain, address: w.address, label: w.label, class: w.entityClass, source: w.source, confidence: w.confidence })));
  const unplaced = cliWallets.filter((w) => !w.chains.length).map((w) => w.address);
  if (unplaced.length) throw new Error(`--wallet ${unplaced.join(", ")}: no configured --chain of that address type`);
  return { slug, files: wallets.length ? applyAnswers(files, { wallets }, { slug, sections: ["wallets"] }) : files };
}

export function validateScaffold({ slug, files }) {
  const errors = [];
  const pc = validateProjectConfig(files[`config/projects/${slug}.json`]);
  errors.push(...pc.errors.map((e) => `project: ${e}`));
  errors.push(...validateLedgerConfig(files[`config/projects/${slug}/ledger.json`], { projectSlug: slug }).map((e) => `ledger: ${e}`));
  const warnings = [...pc.warnings];
  // projectSizing() throws without it (generate-wallet-flows calls it at module load) and the registry sizing test fails.
  if (!(Number(files[`config/projects/${slug}.json`]?.supply?.target) > 0)) warnings.push("supply.target is not set: pass --supply-target <whole tokens>; wallet-flows, holder sizing and check-go-live fail without it (scripts/onboard.js always passes it)");
  return { errors, warnings };
}

/** Paths in messages are the effective ones: under --root the file is in that directory, not in the current one. */
const shownPath = (args, root) => (rel) => (args.root ? path.join(root, rel) : rel);

/**
 * What is left after a successful --write, from what scripts/onboard-run.js really does (nothing below is repeated by it).
 * `root` is set only when --root was given; the commands that read the files carry it.
 */
export function nextStepsText({ slug, root = null, answers = null, hasImage = true, nativeCoin = false }) {
  const git = root ? `git -C ${root}` : "git";
  return `Next steps for ${slug}:
  1. npx vitest run scripts/lib   and   npm run typecheck   (run these in the checkout that holds the files)
  2. ${git} status, then ${git} diff: show the diff. Nothing is committed; the owner reviews it.
  3. The owner commits and merges it to main in one PR that also updates README.md (project list, layout map, "Recent work").
  4. After the merge: gh workflow run onboard-project.yml -f project=${slug}   (after every stop it prints a Fix: block; fix it, merge, dispatch again)
  5. npm run onboard:check -- --project ${slug}
Still manual (the runner does none of these):
  - Verify every address in the answers against an explorer${hasImage ? "" : `; add the token image public/tokens/${slug}.<ext> and "image" in config/projects/${slug}.json`}.
  - ${nativeCoin ? `Native coin: no answers file. Its classification (treasury accounts, CEX list, DEX role), forensics registry and owner decisions come from the chain adapter (scripts/lib/hedera/*), applied by scripts/onboard.js; a decision changes there, never by hand in the config.` : answers ? `Owner decisions go in config/projects/${slug}/onboarding.answers.json (rerun the scaffold with --answers to apply them), never by hand in the config.` : `No answers file was used: staking, wallets, DEX pools, CEX list and history start are undecided. Run scripts/onboard.js for the template and re-run with --answers.`}
  - Optional: a botCluster in config/projects/${slug}/ledger.json if one is known (docs/LEDGER.md).
  - Nightly jobs listed "n/a" above: each needs the missing capability or a nightly.waivers.<jobId> reason in config/projects/${slug}.json (docs/MULTI-TOKEN.md, "Nightly run checklist").`;
}

/** Re-apply owner answers to an already-scaffolded project: merge only the answers-derived fields, no --force. */
function reapplyAnswers(args, root, logger) {
  const slug = String(args.slug).trim().toLowerCase();
  const files = readProjectFiles(root, slug);
  const removed = [];
  const reclassified = [];
  const conflicts = [];
  const next = applyAnswers(files, args.answers, { slug, onRemoved: (row) => removed.push(row), onReclassified: (row) => reclassified.push(row), onConflict: (row) => conflicts.push(row) });
  const errors = [
    ...validateProjectConfig(next[`config/projects/${slug}.json`]).errors.map((e) => `project: ${e}`),
    ...validateLedgerConfig(next[`config/projects/${slug}/ledger.json`], { projectSlug: slug }).map((e) => `ledger: ${e}`),
  ];
  if (errors.length) throw new Error(`merged config is invalid (nothing written):\n  - ${errors.join("\n  - ")}`);
  const changed = writeProjectFiles(root, next, { dryRun: args.dryRun });
  const shown = shownPath(args, root);
  logger.log(`${slug} is already scaffolded: merged the answers into its files (hand edits outside the answers' scope are kept).`);
  for (const rel of changed) logger.log(`${args.dryRun ? "would write" : "write"} ${shown(rel)}`);
  for (const r of removed) logger.log(`${args.dryRun ? "would remove" : "removed"} ${shown(r.file)}: ${r.address}${r.label ? ` (${r.label})` : ""}`);
  const describe = (w) => `${w.class} (${w.label})`;
  for (const r of reclassified) logger.log(`${args.dryRun ? "would reclassify" : "reclassified"} ${r.address}: ${describe(r.from)} -> ${describe(r.to)}`);
  for (const c of conflicts) logger.log(`WARNING kept hand-written ${shown(c.file)}: ${c.address}${c.label ? ` (answers list it as "${c.label}")` : ""}; the answers do not apply to it. Delete the hand-written row to let the answers own it.`);
  if (!changed.length) logger.log("nothing to change: the files already reflect the answers");
  if (!args.dryRun) logger.log(`\n${nextStepsText({ slug, root: args.root ? root : null, answers: args.answers })}`);
  return { slug, files: next, reapplied: true, changed, removed, reclassified, conflicts };
}

export function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root ?? process.cwd());
  const registry = JSON.parse(fs.readFileSync(path.join(root, "config/projects.json"), "utf8"));
  if (args.answersFile) {
    args.answers = assertAnswers(JSON.parse(fs.readFileSync(path.resolve(args.answersFile), "utf8")), args.answersFile);
    if (!args.dryRun) assertWritable(args.answers, args.answersFile);
    if (args.answers.slug && args.slug && args.answers.slug !== args.slug) throw new Error(`--slug ${args.slug} does not match the answers file slug ${args.answers.slug}`);
    args.slug ??= args.answers.slug;
    if (registry.projects.some((p) => p.slug === String(args.slug).trim().toLowerCase()) && !args.force) return reapplyAnswers(args, root, logger);
  }
  const result = scaffold(args, registry);
  // Step 1 (docs/MULTI-TOKEN.md): chain & contract discovery comes BEFORE seeding.
  // The inventory must list every --chain, and decide every other chain found.
  if (!args.inventory) {
    throw new Error(
      "--inventory <chains-inventory.json> is required: run chain & contract discovery first\n" +
        "  node scripts/detect-token-chains.js --address <token> --chain <chain> --ticker <T> --coingecko --out /tmp/d.json\n" +
        "  then build the inventory (scripts/chain-inventory.js, or by hand: config/projects/<slug>/chains-inventory.json schema)",
    );
  }
  const inventory = JSON.parse(fs.readFileSync(path.resolve(args.inventory), "utf8"));
  inventory.slug ??= result.slug;
  const invErrors = validateInventory(result.files[`config/projects/${result.slug}.json`], inventory);
  if (invErrors.length) throw new Error(`chains inventory does not cover this project:\n  - ${invErrors.join("\n  - ")}`);
  result.files[inventoryRelPath(result.slug)] = inventory;
  logger.log(`Chains inventory: ${inventory.chains.map((r) => `${r.chain}=${r.status}`).join(", ")}`);
  const { errors, warnings } = validateScaffold(result);
  for (const w of warnings) logger.warn(`warning: ${w}`);
  if (errors.length) throw new Error(`scaffold is invalid:\n  - ${errors.join("\n  - ")}`);
  for (const rel of Object.keys(result.files)) {
    if (rel === "config/projects.json") continue;
    if (fs.existsSync(path.join(root, rel)) && !args.force) throw new Error(`${rel} already exists. Re-run with --answers <file> to merge owner decisions into the existing files; --force would overwrite it (needs env ONBOARD_FORCE=${result.slug}).`);
  }
  if (args.force && !args.dryRun) {
    const existing = Object.keys(result.files).filter((rel) => rel !== "config/projects.json" && fs.existsSync(path.join(root, rel)));
    if (process.env.ONBOARD_FORCE !== result.slug) {
      throw new Error(
        `--force rewrites every scaffold file and drops hand edits${existing.length ? `: ${existing.join(", ")}` : ""}.\n` +
          `  To change owner decisions use --answers <file> instead (idempotent merge). To really overwrite, set ONBOARD_FORCE=${result.slug} for this command.`,
      );
    }
  }
  const shown = shownPath(args, root);
  for (const [rel, doc] of Object.entries(result.files)) {
    logger.log(`${args.dryRun ? "would write" : "write"} ${shown(rel)}`);
    if (args.dryRun) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(doc, null, 2) + "\n");
  }
  if (!args.dryRun) {
    try {
      const entry = nightlyPlan(root).projects.find((p) => p.slug === result.slug);
      logger.log(`\nNightly jobs (config/nightly-jobs.json) for ${result.slug}:`);
      for (const j of entry?.jobs ?? []) logger.log(`  ${j.status.padEnd(6)} ${j.id}${j.reason ? ` — ${j.reason}` : ""}`);
    } catch (err) {
      logger.warn(`warning: nightly plan unavailable (${err.message})`);
    }
  }
  if (args.dryRun) {
    logger.log(`\nDry run: nothing written for ${result.slug}.`);
    return result;
  }
  const hasImage = Boolean(result.files[`config/projects/${result.slug}.json`].image);
  logger.log(`\n${result.slug} scaffolded and valid.\n${nextStepsText({ slug: result.slug, root: args.root ? root : null, answers: args.answers, hasImage, nativeCoin: args.nativeCoin })}`);
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
