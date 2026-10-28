/**
 * URL rules for the token routes (docs/superpowers/specs/2026-10-26-token-landing-header-design.md):
 * `/` is the landing page, `/<slug>` is a token's terminal. `?token=` and
 * `/holders` are legacy entry points; legacyRedirect() maps them onto `/<slug>`.
 * Pure so it can be tested in node.
 */
import { DEFAULT_PROJECT_SLUG, PROJECTS, TOKEN_PARAM } from "@/lib/projects";

/** First path segments the site already serves. A project slug must never be one of these. */
export const RESERVED_ROOT_SEGMENTS: readonly string[] = [
  "holders",
  "data",
  "live-data",
  "assets",
  "tokens",
  "api",
  ".netlify",
  "sitemap.xml",
  "robots.txt",
  "manifest.json",
  "404.html",
  "index.html",
];

const knownSlugs = (): string[] => PROJECTS.map((p) => p.slug);

export const tokenPath = (slug: string): string => `/${slug}`;

/** The mapped slug a pathname names (`/tel`, `/tel/`), else null. Exact match only. */
export const slugFromPath = (pathname: string, known: readonly string[] = knownSlugs()): string | null => {
  const m = /^\/([^/]+)\/?$/.exec(pathname);
  return m && known.includes(m[1]) ? m[1] : null;
};

export type LocLike = { pathname: string; search: string; hash: string };

/**
 * Where a legacy URL should go (client-side replace), or null to render as is.
 *   /?token=<slug>          -> /<slug>
 *   /holders                -> /<fallback>
 *   /holders?token=<slug>   -> /<slug>
 *   unmapped ?token= value  -> /
 * Other query params (range, chain) and the hash are kept on a slug redirect.
 */
export const legacyRedirect = (
  loc: LocLike,
  known: readonly string[] = knownSlugs(),
  fallback: string = DEFAULT_PROJECT_SLUG,
): string | null => {
  const isRoot = loc.pathname === "/";
  const isHolders = /^\/holders\/?$/.test(loc.pathname);
  if (!isRoot && !isHolders) return null;
  const q = new URLSearchParams(loc.search);
  const raw = q.get(TOKEN_PARAM);
  if (isRoot && raw === null) return null;
  q.delete(TOKEN_PARAM);
  const rest = q.toString() ? `?${q.toString()}` : "";
  if (raw === null) return `${tokenPath(fallback)}${rest}${loc.hash}`;
  const token = raw.trim().toLowerCase();
  if (!known.includes(token)) return "/";
  return `${tokenPath(token)}${rest}${loc.hash}`;
};
