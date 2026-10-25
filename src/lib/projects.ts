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

export type ProjectEntry = {
  slug: string;
  name: string;
  ticker: string;
  default?: boolean;
};

export type ProjectChain = {
  key: string;
  name: string;
  chainId: number;
  explorer: string;
  tokens: Array<{ generation: string; address: string; decimals: number; status?: string; deployBlock?: number }>;
  contracts?: Record<string, { address: string; role: string }>;
};

export type ProjectConfig = ProjectEntry & {
  description?: string;
  links?: Record<string, string>;
  data?: { legacyRoot?: boolean; dir?: string };
  supply?: { target?: number; targetLabel?: string; generationsSumOneToOne?: boolean; note?: string };
  chains: ProjectChain[];
  staking?: Array<{ chain: string; address: string; name: string; token?: string }>;
  classification?: Record<string, string>;
  gated?: { forensics?: boolean };
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
