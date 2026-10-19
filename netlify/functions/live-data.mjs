/**
 * live-data: serve the LATEST committed public/data/*.json without a rebuild.
 *
 * Why this exists: netlify.toml ignores every git-triggered build (each
 * production deploy costs 15 Netlify credits; a daily deploy would be ~450 of
 * the Free plan's 300 a month). So the daily data commits to main never reached
 * the live site, which kept serving whatever was in the last manual deploy.
 *
 * GET /live-data/<file>.json
 *   1. Fetches public/data/<file> from the GitHub repo (private, so it needs a
 *      read-only token in the Netlify env var LIVE_DATA_GITHUB_TOKEN).
 *   2. Returns it with a CDN cache header, so Netlify's durable edge cache
 *      answers almost every visit and this function runs about once per file
 *      per hour at most (stale-while-revalidate keeps responses instant).
 *   3. On ANY problem (no token, GitHub down, timeout, non-200) it 302s to the
 *      deployed static copy at /data/<file>, which is exactly what the site
 *      served before this function existed. So it can only add freshness,
 *      never take data away.
 *
 * holders-checkpoint.json is ~5 MB of per-address balances, but the browser
 * only needs each chain's lastBlock (ChainStatusBar). The function strips the
 * balances, cutting ~5 MB of bandwidth per visitor (20 Netlify credits/GB).
 */

export const config = { path: "/live-data/*" };

/** Only files the frontend actually fetches. Everything else 404s. */
export const LIVE_DATA_FILES = new Set([
  "holders-lite.json",
  "holders-summary.json",
  "holders-history.json",
  "holders-checkpoint.json",
  "holder-transitions.json",
  "supply-reconciliation.json",
  "treasury-history.json",
  "tier-outflows.json",
  "exchange-flow-history.json",
  "cex-balance-history.json",
  "classification-changelog.json",
]);

const BROWSER_CACHE = "public, max-age=300";
const CDN_CACHE = "public, durable, max-age=3600, stale-while-revalidate=86400";
const UPSTREAM_TIMEOUT_MS = 8000;

/** Drop per-address balances; keep generatedAt and each chain's lastBlock. */
export const slimCheckpoint = (data) => ({
  ...data,
  chains: Object.fromEntries(
    Object.entries(data?.chains ?? {}).map(([key, chain]) => {
      const { rawBalances: _drop, ...rest } = chain ?? {};
      return [key, rest];
    }),
  ),
});

const staticFallback = (file, reason) =>
  new Response(null, {
    status: 302,
    headers: {
      Location: `/data/${file}`,
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=300",
      "X-Live-Data": `fallback: ${reason}`,
    },
  });

export async function handleLiveData(request, env = process.env, fetchImpl = fetch) {
  const { pathname } = new URL(request.url);
  const file = decodeURIComponent(pathname.replace(/^.*\/live-data\//, ""));
  if (!LIVE_DATA_FILES.has(file)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  }

  const token = env.LIVE_DATA_GITHUB_TOKEN?.trim();
  if (!token) return staticFallback(file, "not configured");

  const repo = env.LIVE_DATA_REPO?.trim() || "fabcrowd/holderdistribution";
  const ref = env.LIVE_DATA_REF?.trim() || "main";
  const url = `https://api.github.com/repos/${repo}/contents/public/data/${encodeURIComponent(file)}?ref=${encodeURIComponent(ref)}`;

  try {
    const upstream = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "holderdistribution-live-data",
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      console.warn(`live-data: GitHub ${upstream.status} for ${file}`);
      return staticFallback(file, `upstream ${upstream.status}`);
    }
    let body = await upstream.text();
    // Never pass through something that is not JSON (an HTML error page, a
    // truncated body): the static copy is better than a parse error.
    const parsed = JSON.parse(body);
    if (file === "holders-checkpoint.json") body = JSON.stringify(slimCheckpoint(parsed));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": BROWSER_CACHE,
        "Netlify-CDN-Cache-Control": CDN_CACHE,
        "X-Live-Data": "github",
      },
    });
  } catch (error) {
    console.warn(`live-data: ${file}: ${error?.message ?? error}`);
    return staticFallback(file, "error");
  }
}

export default (request) => handleLiveData(request);
