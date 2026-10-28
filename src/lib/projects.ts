/**
 * Multi-token project registry for the browser.
 *
 * holderdistribution.com maps any number of tokens with the same Holders /
 * Distribution / Supply terminal. config/projects.json lists them; per-project
 * detail (chains, contracts, supply target, labels) lives in
 * config/projects/<slug>.json. Adding a project is "add both files + its
 * feeds under public/data/<slug>/"; see docs/MULTI-TOKEN.md.
 */
import registry from "../../config/projects.json";
import { chainExplorerLink, explorerRoot, type ChainVm, type ExplorerTemplates } from "./explorerLinks";

export type ProjectEntry = {
  slug: string;
  name: string;
  ticker: string;
  default?: boolean;
};

export type ProjectChain = {
  key: string;
  name: string;
  /** EVM only (a Solana chain has none; validation rejects it there). */
  chainId?: number;
  /** Adapter: "evm" (default) or "solana". A chain keyed "solana" without vm is Solana. */
  vm?: ChainVm;
  /** Solana only: "mainnet-beta" (the only supported cluster). */
  cluster?: "mainnet-beta";
  /** How this chain's supply nets into the project total (default "native"). */
  bridge?: "native" | "lock-mint" | "burn-mint";
  /** Pipeline: the supply-origin chain (bridged copies elsewhere are mirrors). */
  origin?: boolean;
  /** Pipeline: first block the base-token scan starts from (EVM only). */
  fromBlock?: number;
  /** Explorer root. Optional on Solana (defaults to Solscan). */
  explorer?: string;
  /** Link overrides with {address} / {tx} placeholders (src/lib/explorerLinks.ts). */
  explorerTemplates?: ExplorerTemplates;
  tokens: Array<{
    generation?: string;
    address: string;
    decimals?: number;
    status?: string;
    /** EVM only. */
    deployBlock?: number;
    /** Solana only: "spl-token" | "token-2022". */
    program?: "spl-token" | "token-2022";
    symbol?: string;
  }>;
  contracts?: Record<string, { address: string; role: string }>;
  /** Pipeline RPC wiring (scripts/lib/rpc.js configureProjectRpc): key-pool env prefix + keyless public fallbacks. */
  rpc?: { envPrefix?: string; publicUrls?: string[] };
};

export type ProjectConfig = ProjectEntry & {
  description?: string;
  /** Cached CoinGecko coin image, served from public/tokens/ (e.g. "/tokens/tel.png"). Never a remote URL (CSP img-src is 'self'). */
  image?: string;
  links?: Record<string, string>;
  data?: { legacyRoot?: boolean; dir?: string };
  supply?: { target?: number; targetLabel?: string; generationsSumOneToOne?: boolean; note?: string };
  /**
   * Holder-tier settings (src/lib/holderTiers.ts / scripts/lib/holderTiers.js):
   * retail + mega thresholds, Wallet Holdings balance ranges, Distribution
   * tiers (join keys) and top-N concentration sizes. Omitted fields fall back
   * to config/holder-tiers.default.json (TEL's values).
   */
  holders?: import("@/lib/holderTiers").HolderTiersRaw;
  chains: ProjectChain[];
  /** `kind`: "stakeChanged" (StakeChanged events + stakedBy()) or "receiptModule" (ERC-20 receipt module). */
  staking?: Array<{ chain: string; address: string; name: string; token?: string; kind?: string; deployBlock?: number }>;
  /** Pipeline wiring: `chainsConfig` = repo path of a config/chains.json-shaped map (else derived from `chains`). */
  pipeline?: { chainsConfig?: string };
  classification?: Record<string, string>;
  gated?: { forensics?: boolean };
  /**
   * Project-specific copy. `glossary` overrides the generic template for a
   * term id (src/lib/glossary.ts); strings may use {ticker}/{name}/{chains}/{supply}.
   */
  copy?: {
    glossary?: Record<string, { term?: string; definition?: string }>;
    /** Widget string overrides by id (src/lib/projectCopy.ts copyText). */
    text?: Record<string, string>;
    /**
     * Methodology hover-card overrides by section (src/lib/methodology.ts).
     * Link hrefs may use {token:<chain>:<generation>} and {explorer:<chain>}.
     */
    methodology?: Record<string, { how?: string; verify?: string; links?: Array<{ label: string; href: string }> }>;
  };
};

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const configModules = import.meta.glob<ProjectConfig>("../../config/projects/*.json", {
  eager: true,
  import: "default",
});

const CONFIGS: Record<string, ProjectConfig> = Object.fromEntries(
  Object.entries(configModules).map(([file, cfg]) => [file.replace(/^.*\/([^/]+)\.json$/, "$1"), cfg]),
);

/** Registered projects whose config file exists, in registry order. */
export const PROJECTS: readonly ProjectEntry[] = (registry.projects as ProjectEntry[]).filter(
  (p) => SLUG_RE.test(p.slug) && CONFIGS[p.slug],
);

export const DEFAULT_PROJECT_SLUG: string =
  PROJECTS.find((p) => p.default)?.slug ?? PROJECTS[0]?.slug ?? "tel";

export const isProjectSlug = (v: unknown): v is string =>
  typeof v === "string" && PROJECTS.some((p) => p.slug === v);

export const getProject = (slug: string): ProjectConfig => {
  const entry = PROJECTS.find((p) => p.slug === slug) ?? PROJECTS.find((p) => p.slug === DEFAULT_PROJECT_SLUG)!;
  // Registry wins for the identity fields so the switcher and pages agree.
  return { ...CONFIGS[entry.slug], ...entry };
};

/** "100B" style label for the supply target, from config or derived. */
export const supplyTargetLabel = (p: Pick<ProjectConfig, "supply">): string | null => {
  if (p.supply?.targetLabel) return p.supply.targetLabel;
  const t = p.supply?.target;
  if (!t || !Number.isFinite(t)) return null;
  if (t >= 1e9) return `${+(t / 1e9).toFixed(2)}B`;
  if (t >= 1e6) return `${+(t / 1e6).toFixed(2)}M`;
  return t.toLocaleString("en-US");
};

export const TOKEN_PARAM = "token";
export const PROJECT_STORAGE_KEY = "ha:project";

/**
 * Active slug at load: a valid ?token= wins (shared links), then the last
 * choice remembered in localStorage, then the registry default. Unknown or
 * malformed values are ignored, never trusted.
 */
export const resolveInitialSlug = (
  search: string,
  stored: string | null | undefined,
  known: readonly string[] = PROJECTS.map((p) => p.slug),
  fallback: string = DEFAULT_PROJECT_SLUG,
): string => {
  const ok = (v: unknown): v is string => typeof v === "string" && known.includes(v);
  const fromUrl = new URLSearchParams(search).get(TOKEN_PARAM)?.trim().toLowerCase();
  if (ok(fromUrl)) return fromUrl;
  if (ok(stored)) return stored;
  return fallback;
};

type LocLike = { pathname: string; search: string; hash: string };

/**
 * URL for `loc` with ?token= set to `slug`. The default project is omitted so a
 * plain URL stays plain (same rule as range/chain). Null when nothing changes.
 */
export const withToken = (loc: LocLike, slug: string, defaultSlug: string = DEFAULT_PROJECT_SLUG): string | null => {
  const q = new URLSearchParams(loc.search);
  if (slug === defaultSlug) q.delete(TOKEN_PARAM);
  else q.set(TOKEN_PARAM, slug);
  const search = q.toString() ? `?${q.toString()}` : "";
  if (search === loc.search) return null;
  return `${loc.pathname}${search}${loc.hash}`;
};

export type ProjectChainMeta = { key: string; label: string; explorerUrl: string; tokenUrl: string };

/**
 * Display metadata for each chain a project declares, in declaration order:
 * label, explorer root and the canonical token's explorer page (status
 * "canonical", else the last token listed). TEL resolves to exactly the old
 * hard-coded Ethereum / Polygon / Base entries (projects.test.ts).
 */
export const projectChainMeta = (project: Pick<ProjectConfig, "chains">): ProjectChainMeta[] =>
  (project.chains ?? []).map((c) => {
    const explorer = (c.explorer ?? "").replace(/\/+$/, "");
    const tokens = c.tokens ?? [];
    const canonical = tokens.find((t) => t.status === "canonical") ?? tokens[tokens.length - 1];
    return {
      key: c.key,
      label: c.name,
      explorerUrl: explorerRoot(c) || explorer,
      // EVM: `${explorer}/token/<lowercased>` exactly as before; Solana: Solscan
      // (or explorerTemplates), base58 case kept.
      tokenUrl: canonical ? chainExplorerLink(c, "token", canonical.address, { lowercase: true }) : explorer,
    };
  });
