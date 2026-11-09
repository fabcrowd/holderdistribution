/**
 * Developer-wallet ledger config: load, validate and index
 * config/projects/<slug>/ledger.json (docs/LEDGER.md).
 *
 * Pure apart from the file reads, so tests can feed a config object directly.
 * EVM addresses are lowercased; Solana (base58) addresses are kept as written.
 */
import fs from "node:fs";
import path from "node:path";
import { assertChainVm } from "../chainVms.js";
import { loadProjectClassification, projectRoleAddresses, SLUG_RE } from "../projects.js";

export const LEDGER_WINDOWS = ["24h", "72h", "30d", "90d"];
export const LEDGER_WINDOW_SECONDS = { "24h": 86400, "72h": 3 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 };
export const ZERO_EVM = "0x0000000000000000000000000000000000000000";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TX_TYPES_FILE = "config/ledger-tx-types.json";

export const isEvmAddress = (a) => EVM_RE.test(String(a ?? ""));
export const isSolanaAddress = (a) => SOL_RE.test(String(a ?? "")) && !String(a).startsWith("0x");
/** Developer-wallet address test per vm (ledger wallets carry no vm of their own). */
const WALLET_ADDRESS_TESTS = { evm: isEvmAddress, solana: isSolanaAddress };
/** The vm a developer-wallet address belongs to, or null when it matches none. */
export const walletAddressVm = (a) => Object.keys(WALLET_ADDRESS_TESTS).find((vm) => WALLET_ADDRESS_TESTS[vm](a)) ?? null;
/** Canonical form: EVM lowercased, base58 untouched. */
export const addr = (a) => {
  const s = String(a ?? "").trim();
  return isEvmAddress(s) ? s.toLowerCase() : s;
};

export const ledgerConfigRelPath = (slug) => `config/projects/${slug}/ledger.json`;
/** Output dir is the same shape for every project, TEL included (new files, never served). */
export const ledgerOutRelDir = (slug) => `data/${slug}/ledger`;

export function loadTxTypes(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, TX_TYPES_FILE), "utf8"));
}

export function loadLedgerConfig(slug, root = process.cwd()) {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug: ${slug}`);
  const file = path.join(root, ledgerConfigRelPath(slug));
  if (!fs.existsSync(file)) throw new Error(`no ledger config for ${slug} (${ledgerConfigRelPath(slug)}); run node scripts/add-project.js or create it`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const asMapEntries = (v) => (Array.isArray(v) ? v.map((x) => [x.address, x.label ?? x.name ?? ""]) : Object.entries(v ?? {}));

/**
 * Problems with a ledger config ([] = valid). `projectSlug` must match `slug`.
 * Checks the address shapes, the bot-cluster funding split, windows and stablecoins.
 */
export function validateLedgerConfig(cfg, { projectSlug } = {}) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") return ["ledger config is not an object"];
  if (cfg.version !== 1) errors.push("version must be 1");
  if (projectSlug && cfg.slug !== projectSlug) errors.push(`slug ${cfg.slug} does not match project ${projectSlug}`);
  if (!Array.isArray(cfg.chains) || cfg.chains.length === 0) errors.push("chains must list at least one chain key");
  for (const w of cfg.windows ?? []) if (!LEDGER_WINDOWS.includes(w)) errors.push(`unknown window ${w}`);
  if (!Array.isArray(cfg.developerWallets)) errors.push("developerWallets must be an array");
  const seen = new Set();
  for (const w of cfg.developerWallets ?? []) {
    if (!walletAddressVm(w?.address)) errors.push(`developer wallet has a bad address: ${w?.address}`);
    if (!w?.label) errors.push(`developer wallet ${w?.address} needs a label`);
    const a = addr(w?.address);
    if (seen.has(a)) errors.push(`duplicate developer wallet ${a}`);
    seen.add(a);
  }
  for (const [chain, list] of Object.entries(cfg.stablecoins ?? {})) {
    if (!Array.isArray(list)) errors.push(`stablecoins.${chain} must be an array`);
    for (const s of list ?? []) {
      if (!s?.address || !s?.symbol || !Number.isInteger(s?.decimals)) errors.push(`stablecoins.${chain}: each entry needs address, symbol, decimals`);
    }
  }
  for (const [relay, r] of Object.entries(cfg.relays ?? {})) {
    if (!["cex", "custody", "bridge", "dex"].includes(r?.kind)) errors.push(`relay ${relay}: kind must be cex | custody | bridge | dex`);
    if (seen.has(addr(relay))) errors.push(`relay ${relay} is also a developer wallet`);
  }
  const bot = cfg.botCluster;
  if (bot != null) {
    if (!Array.isArray(bot.addresses) || bot.addresses.length === 0) errors.push("botCluster.addresses must be non-empty");
    if (!bot.chain) errors.push("botCluster.chain is required");
    if (bot.attribution !== "pro-rata") errors.push('botCluster.attribution must be "pro-rata"');
    const funding = bot.funding ?? [];
    if (!funding.some((f) => f.source === "developer")) errors.push("botCluster.funding needs at least one developer source");
    for (const f of funding) {
      if (!["developer", "external"].includes(f.source)) errors.push(`botCluster.funding source must be developer | external (got ${f.source})`);
      if (!(Number(f.amount) > 0)) errors.push(`botCluster.funding ${f.label}: amount must be > 0`);
    }
    for (const a of bot.addresses ?? []) if (seen.has(addr(a))) errors.push(`bot wallet ${a} is also a developer wallet`);
  }
  if (cfg.trace && !(Number.isInteger(cfg.trace.maxHops) && cfg.trace.maxHops >= 1 && cfg.trace.maxHops <= 4)) errors.push("trace.maxHops must be 1-4");
  return errors;
}

/**
 * Developer share of the bot cluster's funding: developer / (developer + external).
 * The owner's rule: only the developer-funded share of bot sales counts as developer selling.
 */
export function botDevShare(botCluster) {
  if (!botCluster?.funding?.length) return 0;
  let dev = 0;
  let total = 0;
  for (const f of botCluster.funding) {
    const v = Number(f.amount) || 0;
    total += v;
    if (f.source === "developer") dev += v;
  }
  return total > 0 ? dev / total : 0;
}

/**
 * Lookup tables used by classify(). `project` (optional) lets the config pull
 * in the project's CEX list, DEX list and contract roles instead of copying them.
 */
export function buildLedgerIndex(cfg, { project = null, root = process.cwd() } = {}) {
  const dev = new Map((cfg.developerWallets ?? []).map((w) => [addr(w.address), w]));
  const relays = new Map(Object.entries(cfg.relays ?? {}).map(([a, r]) => [addr(a), { ...r, endpoint: r.endpoint ? addr(r.endpoint) : null }]));
  const venue = (k) => new Map(asMapEntries(cfg.venues?.[k]).map(([a, l]) => [addr(a), l]));
  const cex = venue("cex");
  const dex = venue("dex");
  const bridges = venue("bridges");
  const custody = venue("custody");
  const staking = venue("staking");

  if (project) {
    if (cfg.venues?.useProjectCexList) {
      const doc = loadProjectClassification(project, "cexWallets", { wallets: [] }, root);
      for (const w of doc?.wallets ?? []) if (!cex.has(addr(w.address))) cex.set(addr(w.address), w.walletName ?? w.label ?? "CEX");
    }
    if (cfg.venues?.useProjectDexList) {
      const doc = loadProjectClassification(project, "dexContracts", { pools: [], routers: [] }, root);
      for (const p of doc?.pools ?? []) if (!dex.has(addr(p.address))) dex.set(addr(p.address), [p.dex, p.pair].filter(Boolean).join(" "));
      for (const r of doc?.routers ?? []) if (!dex.has(addr(r.address))) dex.set(addr(r.address), r.name ?? "DEX router");
    }
    const roles = cfg.venues?.projectRoles;
    if (roles) {
      const byRole = projectRoleAddresses(project.config, { roles: new Set([...(roles.dex ?? []), ...(roles.staking ?? []), ...(roles.cex ?? [])]) });
      for (const list of Object.values(byRole)) {
        for (const e of list) {
          const target = (roles.dex ?? []).includes(e.role) ? dex : (roles.staking ?? []).includes(e.role) ? staking : cex;
          if (!dev.has(addr(e.address)) && !target.has(addr(e.address))) target.set(addr(e.address), e.name ?? e.role);
        }
      }
    }
  }
  // A developer wallet is never a venue, even if a shared list labels it.
  for (const m of [cex, dex, bridges, custody, staking]) for (const a of dev.keys()) m.delete(a);

  const stablecoins = new Map();
  for (const [chain, list] of Object.entries(cfg.stablecoins ?? {})) {
    for (const s of list ?? []) stablecoins.set(`${chain}:${addr(s.address)}`, { ...s, address: addr(s.address), chain });
  }
  const bot = new Set((cfg.botCluster?.addresses ?? []).map(addr));
  return { dev, relays, cex, dex, bridges, custody, staking, stablecoins, bot, botShare: botDevShare(cfg.botCluster) };
}

/** Which developer wallets to scan on `chain` (empty `chains` = every chain of the right VM). */
export function walletsForChain(cfg, chain, vm) {
  const isVmAddress = WALLET_ADDRESS_TESTS[assertChainVm(vm)];
  if (!isVmAddress) throw new Error(`developer-wallet ledgers are not supported for vm ${JSON.stringify(vm)} yet`);
  return (cfg.developerWallets ?? []).filter((w) => {
    const ok = isVmAddress(w.address);
    if (!ok) return false;
    return !Array.isArray(w.chains) || w.chains.length === 0 || w.chains.includes(chain);
  });
}
