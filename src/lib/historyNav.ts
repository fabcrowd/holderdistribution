/**
 * Browser-history policy for the dashboard.
 *
 *   - Navigation (view, sub-panel, Dashboard/Explore) is PUSHED, so the
 *     browser Back button returns to the previous view instead of leaving
 *     the site.
 *   - Settings (time range, chain) are REPLACED into the query string: they
 *     survive reload and sharing, but flipping a dropdown five times doesn't
 *     leave five Back steps behind.
 *
 * Pure helpers take a location-like object so they are testable in node.
 */
import type { DisplaySelection } from "@/hooks/useHolderSnapshot";

export type NavKind = "push" | "replace";

type LocLike = { pathname: string; search: string; hash: string };
type HistLike = {
  pushState: (data: unknown, unused: string, url: string) => void;
  replaceState: (data: unknown, unused: string, url: string) => void;
};

const CHAIN_VALUES: readonly DisplaySelection[] = ["combined", "ethereum", "polygon", "base"];

/** URL for `loc` with its hash swapped. Null when nothing would change. */
export const withHash = (loc: LocLike, hash: string): string | null => {
  const next = hash.startsWith("#") ? hash : `#${hash}`;
  if (loc.hash === next) return null;
  return `${loc.pathname}${loc.search}${next}`;
};

export type UrlSettings = { range: number | null; chain: DisplaySelection | null };

/** Reads ?range=<days>&chain=<chain>. Unknown values read as null (default). */
export const readSettings = (search: string, validRanges: readonly number[]): UrlSettings => {
  const q = new URLSearchParams(search);
  const r = Number(q.get("range"));
  const c = q.get("chain") as DisplaySelection | null;
  return {
    range: Number.isFinite(r) && validRanges.includes(r) ? r : null,
    chain: c && CHAIN_VALUES.includes(c) ? c : null,
  };
};

/**
 * URL for `loc` with range/chain written into the query. Defaults are
 * omitted (a plain URL stays plain). Null when nothing would change.
 */
export const withSettings = (
  loc: LocLike,
  settings: { range: number; chain: DisplaySelection },
  defaults: { range: number; chain: DisplaySelection },
): string | null => {
  const q = new URLSearchParams(loc.search);
  if (settings.range === defaults.range) q.delete("range");
  else q.set("range", String(settings.range));
  if (settings.chain === defaults.chain) q.delete("chain");
  else q.set("chain", settings.chain);
  const search = q.toString() ? `?${q.toString()}` : "";
  if (search === loc.search) return null;
  return `${loc.pathname}${search}${loc.hash}`;
};

/** Applies a navigation to `history`; returns what it did (for tests). */
export const navigate = (hist: HistLike, url: string | null, kind: NavKind): NavKind | null => {
  if (url == null) return null;
  if (kind === "push") hist.pushState(null, "", url);
  else hist.replaceState(null, "", url);
  return kind;
};
