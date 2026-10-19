/**
 * Where the browser loads public/data/* feeds from.
 *
 * Production reads `/live-data/<file>` (netlify/functions/live-data.mjs), which
 * serves the latest copy committed by the daily data workflow without a Netlify
 * rebuild, and 302s to the deployed static `/data/<file>` whenever it cannot.
 * Dev (`vite`) has no functions, so it reads `/data/` directly. Set
 * VITE_LIVE_DATA=off at build time to force the static path (e.g. `vite preview`).
 */
export const LIVE_DATA_SEGMENT = "live-data";
export const STATIC_DATA_SEGMENT = "data";

export const liveDataEnabled = (): boolean =>
  !import.meta.env.DEV && !/^(off|false|0|no)$/i.test(import.meta.env.VITE_LIVE_DATA ?? "");

export const resolveDataUrl = (
  file: string,
  { base = import.meta.env.BASE_URL ?? "/", live = liveDataEnabled() }: { base?: string; live?: boolean } = {},
): string => {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}${live ? LIVE_DATA_SEGMENT : STATIC_DATA_SEGMENT}/${file}`;
};
