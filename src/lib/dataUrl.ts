/**
 * Where the browser loads a project's feeds from (multi-token layout,
 * docs/MULTI-TOKEN.md): `<base>live-data/<slug>/<file>` in production,
 * `<base>data/<slug>/<file>` in dev or with live data off.
 *
 * Production reads `/live-data/<slug>/<file>` (netlify/functions/live-data.mjs),
 * which serves the latest copy committed by the daily data workflow without a
 * Netlify rebuild, and 302s to the deployed static `/data/<slug>/<file>`
 * whenever it cannot. Dev (`vite`) has no functions, so it reads `/data/<slug>/`
 * directly (vite.config.ts maps legacy-root projects like TEL onto
 * public/data/). Set VITE_LIVE_DATA=off at build time to force the static path.
 */
import { DEFAULT_PROJECT_SLUG } from "@/lib/projects";

export const LIVE_DATA_SEGMENT = "live-data";
export const STATIC_DATA_SEGMENT = "data";

export const liveDataEnabled = (): boolean =>
  !import.meta.env.DEV && !/^(off|false|0|no)$/i.test(import.meta.env.VITE_LIVE_DATA ?? "");

type UrlOpts = { base?: string; live?: boolean };

const normalizeBase = (base: string): string => {
  const lead = base.startsWith("/") || /^[a-z]+:\/\//i.test(base) ? base : `/${base}`;
  return lead.endsWith("/") ? lead : `${lead}/`;
};

/** URL of `file` for project `slug`. */
export const dataUrl = (
  slug: string,
  file: string,
  { base = import.meta.env.BASE_URL ?? "/", live = liveDataEnabled() }: UrlOpts = {},
): string => `${normalizeBase(base)}${live ? LIVE_DATA_SEGMENT : STATIC_DATA_SEGMENT}/${encodeURIComponent(slug)}/${file}`;

/**
 * Pre-multi-token helper: the default project's feed. Prefer
 * `dataUrl(slug, file)` with the slug from useProject().
 */
export const resolveDataUrl = (file: string, opts: UrlOpts = {}): string => dataUrl(DEFAULT_PROJECT_SLUG, file, opts);
