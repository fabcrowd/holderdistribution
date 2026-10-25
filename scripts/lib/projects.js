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
  return {
    slug,
    config: loadProjectConfig(slug, root),
    dataDir: projectDataDir(slug, root),
    isDefault: entry.default === true,
  };
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
    for (const [name, v] of Object.entries(c.contracts ?? {})) contracts[name] = { address: lc(v.address) };
    const modules = (config.staking ?? [])
      .filter((s) => s.chain === c.key && s.kind === "receiptModule")
      .map((s) => ({ address: lc(s.address), name: s.name, decimals: v3?.decimals, deployBlock: s.deployBlock }));
    out[c.key] = {
      key: c.key,
      name: c.name,
      chainId: c.chainId,
      ...(c.origin ? { origin: true } : {}),
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
 * The chain map a ported script scans. `pipeline.chainsConfig` (a repo path)
 * wins; a legacyRoot project without it keeps config/chains.json (TEL: every
 * byte the pipeline read before stays identical); otherwise it is derived from
 * the project's own `chains[]`.
 */
export function projectChains(project, root = process.cwd()) {
  const file = project.config?.pipeline?.chainsConfig ?? (project.config?.data?.legacyRoot === true ? "config/chains.json" : null);
  if (file) return JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8"));
  return deriveChainsFromProject(project.config);
}

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
  return {
    exclusionsPath: projectClassificationPath(project, "exclusions", root),
    cexPath: projectClassificationPath(project, "cexWallets", root),
    dexPath: projectClassificationPath(project, "dexContracts", root),
  };
}
