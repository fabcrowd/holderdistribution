/**
 * Node-side view of the multi-token project registry (config/projects.json +
 * config/projects/<slug>.json). Used by the build (prune-dist-data.js), the
 * Vite dev server (vite.config.ts) and tests. The browser has its own typed
 * copy in src/lib/projects.ts; netlify/functions/live-data.mjs keeps a tiny
 * constant list that scripts/lib/projects.test.js holds in sync with this.
 *
 * Data layout (docs/MULTI-TOKEN.md):
 *   public/data/<slug>/<feed>.json   — every project's feeds, same filenames
 *   public/data/<feed>.json          — "legacyRoot" projects only (TEL today):
 *                                      their pipelines still write the
 *                                      pre-multi-token root. The site serves
 *                                      them at /data/<slug>/ anyway.
 */
import fs from "node:fs";
import path from "node:path";
import { configureProjectRpc } from "./rpc.js";
import { isEvmAddress, isSolanaAddress } from "./address.js";
import { BRIDGE_MODES, CHAIN_VMS, SOLANA_CLUSTERS, defaultExplorerTemplates, resolveChainBridge, resolveChainVm } from "./chainAdapters.js";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function loadRegistry(root = process.cwd()) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "config/projects.json"), "utf8"));
  const projects = raw.projects ?? [];
  return projects;
}

export function loadProjectConfig(slug, root = process.cwd()) {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug: ${slug}`);
  return JSON.parse(fs.readFileSync(path.join(root, "config/projects", `${slug}.json`), "utf8"));
}

/** Repo-relative directory holding a project's feeds. */
export function projectDataDir(slug, root = process.cwd()) {
  const cfg = loadProjectConfig(slug, root);
  return cfg?.data?.legacyRoot ? "public/data" : `public/data/${slug}`;
}

/** Slugs whose feeds still live at the public/data/ root. */
export function legacyRootSlugs(root = process.cwd()) {
  return loadRegistry(root)
    .map((p) => p.slug)
    .filter((slug) => loadProjectConfig(slug, root)?.data?.legacyRoot === true);
}

/** The registry's default project (TEL today). */
export function defaultProjectSlug(root = process.cwd()) {
  const registry = loadRegistry(root);
  return (registry.find((p) => p.default) ?? registry[0])?.slug ?? "tel";
}

/**
 * Pipeline `--project <slug>` selection. Accepts `--project slug` or
 * `--project=slug`; falls back to the HD_PROJECT env var (set once per job by
 * the workflows' `project` dispatch input), then to the registry default.
 * Returns the raw slug; resolveProject() validates it against the registry.
 */
export function parseProjectArg(argv = process.argv.slice(2), env = process.env, root = process.cwd()) {
  let slug;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--project needs a slug, e.g. --project tel");
      slug = next;
      i++;
    } else if (a.startsWith("--project=")) {
      slug = a.slice("--project=".length);
      if (!slug) throw new Error("--project needs a slug, e.g. --project=tel");
    }
  }
  if (slug === undefined) slug = (env?.HD_PROJECT ?? "").trim() || defaultProjectSlug(root);
  slug = slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug: ${JSON.stringify(slug)}`);
  return slug;
}

/** Registry-checked project: { slug, config, dataDir, isDefault }. */
export function resolveProject(slug, root = process.cwd()) {
  const registry = loadRegistry(root);
  const entry = registry.find((p) => p.slug === slug);
  if (!entry) {
    throw new Error(`unknown project "${slug}" (config/projects.json has: ${registry.map((p) => p.slug).join(", ")})`);
  }
  const config = loadProjectConfig(slug, root);
  const { errors, warnings } = validateProjectConfig(config);
  if (errors.length) throw new Error(`config/projects/${slug}.json is invalid:\n  - ${errors.join("\n  - ")}`);
  return {
    slug,
    config,
    dataDir: projectDataDir(slug, root),
    isDefault: entry.default === true,
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// chains[] validation: vm / bridge / Solana fields (Solana + wrapped/bridged
// design specs, docs/superpowers/specs/2026-10-25-*). Only the NEW fields are
// checked, so every existing EVM config (TEL) validates exactly as written.
// ---------------------------------------------------------------------------

const EVM_ONLY_CHAIN_FIELDS = ["chainId", "fromBlock"];
const EVM_ONLY_TOKEN_FIELDS = ["deployBlock"];
const SOLANA_PROGRAMS = ["spl-token", "token-2022"];
const NON_RETAIL_ROLES = new Set(["bridge", "escrow", "cex", "dex", "staking"]);
const TEMPLATE_KINDS = ["token", "address", "tx"];

/**
 * Validates a project config's chain fields. Returns `{ errors, warnings }`;
 * resolveProject() throws on errors (before any network call) and the
 * pipeline prints warnings.
 */
export function validateProjectConfig(config) {
  const errors = [];
  const warnings = [];
  const chains = Array.isArray(config?.chains) ? config.chains : [];
  const keys = new Set();
  for (const c of chains) {
    const where = `chains[${c?.key ?? "?"}]`;
    if (!c?.key || typeof c.key !== "string") {
      errors.push(`${where}: missing key`);
      continue;
    }
    if (keys.has(c.key)) errors.push(`${where}: duplicate chain key`);
    keys.add(c.key);
    if (c.vm !== undefined && !CHAIN_VMS.includes(c.vm)) errors.push(`${where}: unknown vm ${JSON.stringify(c.vm)} (use ${CHAIN_VMS.join(" | ")})`);
    if (c.bridge !== undefined && !BRIDGE_MODES.includes(c.bridge)) {
      errors.push(`${where}: unknown bridge ${JSON.stringify(c.bridge)} (use ${BRIDGE_MODES.join(" | ")})`);
    }
    if (c.explorerTemplates !== undefined) {
      if (!c.explorerTemplates || typeof c.explorerTemplates !== "object") errors.push(`${where}: explorerTemplates must be an object`);
      else {
        for (const [kind, t] of Object.entries(c.explorerTemplates)) {
          if (!TEMPLATE_KINDS.includes(kind)) errors.push(`${where}: explorerTemplates.${kind} is not one of ${TEMPLATE_KINDS.join(", ")}`);
          else if (typeof t !== "string" || !/^https:\/\//.test(t) || !t.includes(kind === "tx" ? "{tx}" : "{address}")) {
            errors.push(`${where}: explorerTemplates.${kind} must be an https URL containing ${kind === "tx" ? "{tx}" : "{address}"}`);
          }
        }
      }
    }
    const vm = resolveChainVm(c);
    const tokens = Array.isArray(c.tokens) ? c.tokens : [];
    if (vm === "solana") {
      for (const f of EVM_ONLY_CHAIN_FIELDS) if (c[f] !== undefined) errors.push(`${where}: ${f} is EVM-only; remove it from a Solana chain`);
      if (c.cluster !== undefined && !SOLANA_CLUSTERS.includes(c.cluster)) {
        errors.push(`${where}: cluster ${JSON.stringify(c.cluster)} is not supported (only ${SOLANA_CLUSTERS.join(", ")})`);
      }
      if (tokens.length === 0) errors.push(`${where}: a Solana chain needs tokens[] with a mint address`);
      for (const t of tokens) {
        if (!isSolanaAddress(t?.address)) errors.push(`${where}: token ${JSON.stringify(t?.address)} is not a base58 Solana mint address`);
        else if (t.address !== t.address.trim()) errors.push(`${where}: token ${JSON.stringify(t.address)} has surrounding whitespace`);
        for (const f of EVM_ONLY_TOKEN_FIELDS) if (t?.[f] !== undefined) errors.push(`${where}: token ${t.address} ${f} is EVM-only`);
        if (t?.program !== undefined && !SOLANA_PROGRAMS.includes(t.program)) errors.push(`${where}: token program must be ${SOLANA_PROGRAMS.join(" | ")}`);
        if (t?.decimals !== undefined && !(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18)) errors.push(`${where}: token decimals must be an integer 0-18`);
      }
      for (const [name, v] of Object.entries(c.contracts ?? {})) {
        if (!isSolanaAddress(v?.address)) errors.push(`${where}: contracts.${name} is not a base58 Solana address`);
      }
    } else if (c.vm !== undefined || c.cluster !== undefined) {
      if (c.cluster !== undefined) errors.push(`${where}: cluster is Solana-only`);
      for (const t of tokens) if (t?.program !== undefined) errors.push(`${where}: token program is Solana-only`);
    }
    if (vm === "evm" && (c.vm !== undefined || c.bridge !== undefined)) {
      // Only chains that opt into the new fields get address checks here, so
      // TEL's existing config is never re-interpreted.
      for (const t of tokens) if (!isEvmAddress(t?.address)) errors.push(`${where}: token ${JSON.stringify(t?.address)} is not a 0x address`);
    }
    for (const [name, v] of Object.entries(c.contracts ?? {})) {
      if (v?.role !== undefined && typeof v.role !== "string") errors.push(`${where}: contracts.${name}.role must be a string`);
    }
  }
  const origins = chains.filter((c) => c?.origin);
  if (origins.length > 1) errors.push(`chains: more than one origin chain (${origins.map((c) => c.key).join(", ")})`);
  const lockMint = chains.filter((c) => !c?.origin && resolveChainBridge(c) === "lock-mint");
  if (lockMint.length) {
    if (origins.length === 0) {
      errors.push(`chains: ${lockMint.map((c) => c.key).join(", ")} use bridge "lock-mint" but no chain is marked origin: true`);
    } else {
      const origin = origins[0];
      const hasLock = Object.values(origin.contracts ?? {}).some((v) => v?.role === "bridge" || v?.role === "escrow");
      const exclusionsDeclared = Boolean(config?.classification?.exclusions) || config?.data?.legacyRoot === true;
      if (!hasLock) {
        warnings.push(
          `chains: ${lockMint.map((c) => c.key).join(", ")} use bridge "lock-mint" but origin chain ${origin.key} lists no ` +
            `contract with role "bridge" or "escrow"` + (exclusionsDeclared ? " (relying on exclusions bridge-lock labels)" : "") +
            `; the lock balance cannot be netted out.`,
        );
      }
    }
  }
  if (config?.supply?.generationsSumOneToOne && chains.some((c) => c?.bridge !== undefined)) {
    warnings.push("supply.generationsSumOneToOne is set: chains[].bridge is ignored (the TEL-style supply path is used).");
  }
  return { errors, warnings };
}

/** chains[] entries with their resolved vm and bridge. */
export function projectChainEntries(config) {
  return (config?.chains ?? []).map((c) => ({ ...c, vm: resolveChainVm(c), bridge: resolveChainBridge(c) }));
}

/** Chain keys with this vm, in config order. */
export const projectChainKeysByVm = (config, vm) => projectChainEntries(config).filter((c) => c.vm === vm).map((c) => c.key);

/**
 * Addresses a project's `contracts{}` mark as non-retail (role bridge, escrow,
 * cex, dex, staking), per chain, case preserved for Solana and lowercased for
 * EVM: `{ <chainKey>: [{ name, address, role }] }`.
 */
export function projectRoleAddresses(config, { roles = NON_RETAIL_ROLES } = {}) {
  const wanted = roles instanceof Set ? roles : new Set(roles);
  const out = {};
  for (const c of projectChainEntries(config)) {
    for (const [name, v] of Object.entries(c.contracts ?? {})) {
      if (!v?.address || !wanted.has(v.role)) continue;
      const address = c.vm === "solana" ? v.address.trim() : v.address.trim().toLowerCase();
      (out[c.key] ??= []).push({ name, address, role: v.role });
    }
  }
  return out;
}

/**
 * Entry point for refresh/generate scripts.
 *
 * `ported: true` marks a script that reads every address through the helpers
 * below (projectChains / projectClassificationPath / projectStakingContracts)
 * and writes through projectPaths(): it may run for ANY registered project.
 * A script that has not been ported yet still reads config/chains.json and the
 * public/data/ root directly, i.e. it can only produce a `data.legacyRoot`
 * project (TEL), so any other slug is refused up front and a run can never
 * write one token's numbers under another project's name.
 */
export function pipelineProject(script, { argv = process.argv.slice(2), env = process.env, root = process.cwd(), ported = false } = {}) {
  const project = resolveProject(parseProjectArg(argv, env, root), root);
  if (!ported && project.config?.data?.legacyRoot !== true) {
    throw new Error(
      `${script}: project "${project.slug}" is not wired into the data pipeline yet ` +
        `(this script is not ported; only legacyRoot projects are; see docs/MULTI-TOKEN.md "Pipeline").`,
    );
  }
  return project;
}

/** CLI wrapper: pipelineProject() that prints and exits 2 on a bad selection. */
export function selectPipelineProject(script, { ported = false } = {}) {
  try {
    const project = pipelineProject(script, { ported });
    // Chains the project declares an `rpc` block for get their key pool /
    // public fallbacks registered (TEL declares none: built-ins unchanged).
    configureProjectRpc(project.config);
    console.error(`[${script}] project: ${project.slug} (${project.dataDir})`);
    for (const w of project.warnings ?? []) console.error(`[${script}] config warning: ${w}`);
    return project;
  } catch (err) {
    console.error(`[${script}] ${err.message}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Ported-script helpers: data paths + address resolution from project config.
// ---------------------------------------------------------------------------

/**
 * Absolute path of one feed/checkpoint file in a project's data dir.
 * TEL (legacyRoot) -> <root>/public/data/<file>; others -> <root>/public/data/<slug>/<file>.
 * Same file names for every project (BROWSER_DATA_FILES).
 */
export function projectDataPath(project, file, root = process.cwd()) {
  if (typeof file !== "string" || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    throw new Error(`projectDataPath: bad file name ${JSON.stringify(file)}`);
  }
  return path.resolve(root, project.dataDir, file);
}

/** Repo-relative form of projectDataPath() (for git-history reads such as readCommittedJson). */
export function projectDataRelPath(project, file) {
  return path.posix.join(project.dataDir, file);
}

/** Bind projectDataPath to one project: `const data = projectPaths(project); data("tel-holders.json")`. */
export function projectPaths(project, root = process.cwd()) {
  const fn = (file) => projectDataPath(project, file, root);
  fn.rel = (file) => projectDataRelPath(project, file);
  fn.dir = path.resolve(root, project.dataDir);
  return fn;
}

/**
 * Repo-relative directory for a project's NON-served working files (transfer
 * caches, checkpoints, as-of block maps, forensics, review queues): TEL
 * (legacyRoot) keeps the original `data/` root; others get `data/<slug>/`.
 * Never under public/, so nothing here is deployed.
 */
export function projectWorkDir(project) {
  return project.config?.data?.legacyRoot === true ? "data" : `data/${project.slug}`;
}

/**
 * Absolute path of one working file for a project (projectWorkDir). Sub-paths
 * such as "forensics/wallet-flows.json" are allowed; absolute paths and ".."
 * are refused.
 */
export function projectWorkPath(project, file, root = process.cwd()) {
  if (typeof file !== "string" || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    throw new Error(`projectWorkPath: bad file name ${JSON.stringify(file)}`);
  }
  return path.resolve(root, projectWorkDir(project), file);
}

/** Bind projectWorkPath to one project: `const work = projectWork(project); work("x.json")`. */
export function projectWork(project, root = process.cwd()) {
  const fn = (file) => projectWorkPath(project, file, root);
  fn.rel = (file) => path.posix.join(projectWorkDir(project), file);
  fn.dir = path.resolve(root, projectWorkDir(project));
  return fn;
}

/** Repo-relative path of a classification file (null when none declared). */
export function projectClassificationRelPath(project, kind, root = process.cwd()) {
  const abs = projectClassificationPath(project, kind, root);
  return abs ? path.relative(root, abs).split(path.sep).join("/") : null;
}

/** Classification files every project may declare under `classification`. */
export const CLASSIFICATION_KINDS = {
  cexWallets: "config/cex-wallets.json",
  dexContracts: "config/dex-contracts.json",
  exclusions: "config/exclusions.json",
  changelog: "config/classification-changelog.json",
};

/**
 * Absolute path of a project's classification file (`classification.<kind>`).
 * A legacyRoot project (TEL) falls back to the original config/ root file.
 * Any other project gets null when it declares none: TEL's exclusions are
 * TEL-specific and must never be applied to another token by accident.
 */
export function projectClassificationPath(project, kind, root = process.cwd()) {
  if (!(kind in CLASSIFICATION_KINDS)) throw new Error(`unknown classification kind: ${kind}`);
  const declared = project.config?.classification?.[kind];
  if (declared) return path.resolve(root, declared);
  return project.config?.data?.legacyRoot === true ? path.resolve(root, CLASSIFICATION_KINDS[kind]) : null;
}

const lc = (v) => (typeof v === "string" ? v.trim().toLowerCase() : v);

/**
 * Build the pipeline's chain map (the config/chains.json shape the scanners
 * expect: { <chainKey>: { key, name, chainId, tokenAddress, decimals, fromBlock,
 * explorer, tokens: { legacy, v3? }, contracts } }) from a project's `chains[]`.
 *
 * Token slots: the scanner's base token is the `legacy` slot. A project's token
 * with `generation: "legacy"` fills it; a single-generation project's only
 * token fills it. A `v3` generation fills the v3 slot (upgrade netting via
 * tokenMigration / migrationVault escrow contracts, exactly as TEL). Staking
 * entries with `kind: "receiptModule"` are attached to `tokens.v3.staking`.
 */
export function deriveChainsFromProject(config) {
  const out = {};
  for (const c of config?.chains ?? []) {
    if (resolveChainVm(c) === "solana") {
      out[c.key] = deriveSolanaChain(config, c);
      continue;
    }
    const tokens = c.tokens ?? [];
    const base = tokens.find((t) => t.generation === "legacy") ?? (tokens.length === 1 ? tokens[0] : null);
    if (!base) throw new Error(`project ${config.slug}: chain ${c.key} needs a "legacy" token or exactly one token`);
    const v3 = tokens.find((t) => t.generation === "v3" && t !== base) ?? null;
    const explorer = c.explorer ? c.explorer.replace(/\/$/, "") : null;
    const tokenEntry = (t) => ({
      address: lc(t.address),
      decimals: t.decimals,
      ...(t.deployBlock ? { deployBlock: t.deployBlock } : {}),
      ...(t.status ? { status: t.status } : {}),
    });
    const contracts = {};
    for (const [name, v] of Object.entries(c.contracts ?? {})) contracts[name] = { address: lc(v.address), ...(v.role ? { role: v.role } : {}) };
    const modules = (config.staking ?? [])
      .filter((s) => s.chain === c.key && s.kind === "receiptModule")
      .map((s) => ({ address: lc(s.address), name: s.name, decimals: v3?.decimals, deployBlock: s.deployBlock }));
    out[c.key] = {
      key: c.key,
      name: c.name,
      chainId: c.chainId,
      ...(c.origin ? { origin: true } : {}),
      ...(c.vm ? { vm: c.vm } : {}),
      ...(c.bridge ? { bridge: c.bridge } : {}),
      tokenAddress: lc(base.address),
      decimals: base.decimals,
      fromBlock: c.fromBlock ?? base.deployBlock ?? 0,
      ...(explorer
        ? { explorer: { address: `${explorer}/address/${lc(base.address)}`, token: `${explorer}/token/${lc(base.address)}` } }
        : {}),
      tokens: {
        legacy: tokenEntry(base),
        ...(v3 ? { v3: { ...tokenEntry(v3), ...(modules.length ? { staking: modules } : {}) } } : {}),
      },
      contracts,
    };
  }
  return out;
}

/**
 * Chain-map entry for a Solana chain: addresses kept EXACTLY as written
 * (base58 is case-sensitive), no chainId / fromBlock, Solscan links by
 * default. The scanned (base) token is the legacy / canonical / only token.
 */
function deriveSolanaChain(config, c) {
  const tokens = c.tokens ?? [];
  const base = tokens.find((t) => t.generation === "legacy") ?? tokens.find((t) => t.status === "canonical") ?? tokens[0];
  if (!base) throw new Error(`project ${config?.slug}: Solana chain ${c.key} needs a mint in tokens[]`);
  const address = base.address.trim();
  const templates = { ...defaultExplorerTemplates({ ...c, vm: "solana" }), ...(c.explorerTemplates ?? {}) };
  const contracts = {};
  for (const [name, v] of Object.entries(c.contracts ?? {})) contracts[name] = { address: v.address.trim(), ...(v.role ? { role: v.role } : {}) };
  return {
    key: c.key,
    name: c.name,
    vm: "solana",
    cluster: c.cluster ?? "mainnet-beta",
    ...(c.origin ? { origin: true } : {}),
    ...(c.bridge ? { bridge: c.bridge } : {}),
    tokenAddress: address,
    ...(base.decimals !== undefined ? { decimals: base.decimals } : {}),
    explorer: {
      address: templates.address.replaceAll("{address}", address),
      token: templates.token.replaceAll("{address}", address),
    },
    explorerTemplates: templates,
    tokens: {
      legacy: {
        address,
        ...(base.decimals !== undefined ? { decimals: base.decimals } : {}),
        ...(base.program ? { program: base.program } : {}),
        ...(base.symbol ? { symbol: base.symbol } : {}),
        ...(base.status ? { status: base.status } : {}),
      },
    },
    contracts,
  };
}

/**
 * The chain map a ported script scans. `pipeline.chainsConfig` (a repo path)
 * wins; a legacyRoot project without it keeps config/chains.json (TEL: every
 * byte the pipeline read before stays identical); otherwise it is derived from
 * the project's own `chains[]`.
 *
 * `vms` (default ["evm"]) filters by chain vm; pass "all" for every chain.
 */
export function projectChains(project, root = process.cwd(), { vms = ["evm"] } = {}) {
  const file = project.config?.pipeline?.chainsConfig ?? (project.config?.data?.legacyRoot === true ? "config/chains.json" : null);
  const all = file ? JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8")) : deriveChainsFromProject(project.config);
  if (vms === "all") return all;
  // EVM-only consumers (log scanners, exchange/wallet flows, tier outflows)
  // get the EVM chains only, so a Solana chain is never handed to an
  // eth_getLogs loop. TEL is all-EVM, so this is the same map as before.
  const keep = new Set(vms);
  const filtered = Object.fromEntries(Object.entries(all).filter(([key, c]) => keep.has(resolveChainVm({ key, ...c }))));
  return Object.keys(filtered).length === Object.keys(all).length ? all : filtered;
}

/** The full chain map, every vm (pull-holders-rpc's dispatcher). */
export const projectChainsAllVms = (project, root = process.cwd()) => projectChains(project, root, { vms: "all" });

/**
 * A project's staking contracts, optionally filtered by `kind`
 * ("stakeChanged" = StakeChanged events + stakedBy(); "receiptModule" = ERC-20
 * receipt StakingModule), `chain` or `token` generation. Addresses lowercased.
 */
export function projectStakingContracts(project, { kind, chain, token } = {}) {
  return (project.config?.staking ?? [])
    .filter((s) => (kind ? s.kind === kind : true) && (chain ? s.chain === chain : true) && (token ? s.token === token : true))
    .map((s) => ({ ...s, address: lc(s.address) }));
}

/** Token address for (chainKey, generation) from the project config, or null. */
export function projectTokenAddress(project, chainKey, generation) {
  const chain = (project.config?.chains ?? []).find((c) => c.key === chainKey);
  const tok = (chain?.tokens ?? []).find((t) => t.generation === generation);
  return tok ? lc(tok.address) : null;
}

/**
 * Parsed classification file for a project, or `fallback` when the project
 * declares none (non-legacy) or the file is missing.
 */
export function loadProjectClassification(project, kind, fallback, root = process.cwd()) {
  const file = projectClassificationPath(project, kind, root);
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** loadNonRetailSet() paths for a project (null = none declared -> empty). */
export function projectNonRetailPaths(project, root = process.cwd()) {
  // Generic (bridge-netting) projects: contracts{} entries with a non-retail
  // role (bridge, escrow, cex, dex, staking) are non-retail on every chain
  // without having to repeat them in an exclusions file. TEL (generations
  // path) keeps exactly its classification files.
  const extra =
    project.config?.supply?.generationsSumOneToOne === true
      ? []
      : Object.values(projectRoleAddresses(project.config)).flat().map((e) => e.address);
  return {
    exclusionsPath: projectClassificationPath(project, "exclusions", root),
    cexPath: projectClassificationPath(project, "cexWallets", root),
    dexPath: projectClassificationPath(project, "dexContracts", root),
    ...(extra.length ? { extraAddresses: extra } : {}),
  };
}
