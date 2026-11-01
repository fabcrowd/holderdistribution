/**
 * live-data: serve the LATEST committed public/data/*.json without a rebuild.
 *
 * Why this exists: netlify.toml ignores every git-triggered build (each
 * production deploy costs 15 Netlify credits; a daily deploy would be ~450 of
 * the Free plan's 300 a month). So the daily data commits to main never reached
 * the live site, which kept serving whatever was in the last manual deploy.
 *
 * GET /live-data/<slug>/<file>.json   (multi-token, docs/MULTI-TOKEN.md)
 * GET /live-data/<file>.json          (legacy, = the default project "tel")
 *   1. Fetches the project's feed from the GitHub repo: public/data/<slug>/<file>,
 *      or public/data/<file> for "legacyRoot" projects (TEL, whose pipelines
 *      still write the root). Needs a read-only token in the Netlify env var
 *      LIVE_DATA_GITHUB_TOKEN.
 *   2. Returns it with a CDN cache header, so Netlify's durable edge cache
 *      answers almost every visit and this function runs about once per file
 *      per hour at most (stale-while-revalidate keeps responses instant).
 *   3. On ANY problem (no token, GitHub down, timeout, non-200) it 302s to the
 *      deployed static copy (/data/<slug>/<file>; legacy URLs keep going to
 *      /data/<file>), which is exactly what the site
 *      served before this function existed. So it can only add freshness,
 *      never take data away.
 *
 * The browser reads chain-status.json (each chain's lastBlock). If an old
 * bundle still asks for holders-checkpoint.json (~5 MB of per-address
 * balances) the function strips every balance map before returning it.
 */

export const config = { path: "/live-data/*" };

/**
 * Registered projects come from config/projects.json, which Netlify's esbuild
 * bundler inlines at deploy time (a few hundred bytes, no runtime file read),
 * so registering a token needs no edit here. The per-project config files are
 * NOT imported (~30 KB each and growing): the registry entry carries
 * `legacyRoot: true` for projects whose feeds still live at the public/data/
 * root (TEL), and scripts/lib/projects.test.js fails if it drifts from
 * data.legacyRoot in config/projects/<slug>.json.
 */
import registry from "../../config/projects.json" with { type: "json" };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Pure: slugs, legacy-root slugs and the default slug of a registry object. */
export const buildProjectIndex = (reg) => {
  const entries = (reg?.projects ?? []).filter((p) => SLUG_RE.test(p.slug));
  return {
    slugs: new Set(entries.map((p) => p.slug)),
    legacyRoot: new Set(entries.filter((p) => p.legacyRoot === true).map((p) => p.slug)),
    defaultSlug: (entries.find((p) => p.default) ?? entries[0])?.slug,
  };
};

const PROJECTS = buildProjectIndex(registry);
export const PROJECT_SLUGS = PROJECTS.slugs;
export const LEGACY_ROOT_SLUGS = PROJECTS.legacyRoot;
/** Slug that legacy /live-data/<file> URLs (old bundles) resolve to. */
export const LEGACY_URL_SLUG = PROJECTS.defaultSlug;

/** Parses ".../live-data/<file>" or ".../live-data/<slug>/<file>". Null when invalid. */
export const parseLiveDataPath = (pathname, legacySlug = LEGACY_URL_SLUG) => {
  let rest;
  try {
    rest = decodeURIComponent(pathname.replace(/^.*?\/live-data\//, ""));
  } catch {
    return null;
  }
  const parts = rest.split("/");
  if (parts.length === 1) return { slug: legacySlug, file: parts[0], legacyUrl: true };
  if (parts.length === 2) return { slug: parts[0], file: parts[1], legacyUrl: false };
  return null;
};

/** Repo path of a project's feed. */
export const repoDataPath = (slug, file, index = PROJECTS) =>
  index.legacyRoot.has(slug) ? `public/data/${file}` : `public/data/${slug}/${file}`;

/** Only files the frontend actually fetches. Everything else 404s. */
export const LIVE_DATA_FILES = new Set([
  "holders-lite.json",
  "holders-summary.json",
  "holders-history.json",
  "chain-status.json",
  // No longer fetched by the current bundle (it reads chain-status.json), kept
  // so tabs still running an older bundle get a slimmed copy, not a 404.
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

/**
 * Drop per-address balances at ANY depth (chains.*.rawBalances, chains.*.v3,
 * chains.*.v3Staking.<contract>.rawBalances, …); keep generatedAt and each
 * chain's lastBlock / fromBlock.
 */
export const slimCheckpoint = (data) => {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const [k, child] of Object.entries(v)) {
      if (k === "rawBalances" || k === "balances") continue;
      const s = strip(child);
      // Drop containers that held nothing but balances.
      if (s && typeof s === "object" && !Array.isArray(s) && Object.keys(s).length === 0 && Object.keys(child).length > 0) continue;
      out[k] = s;
    }
    return out;
  };
  return strip(data);
};

const staticFallback = (location, reason) =>
  new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=300",
      "X-Live-Data": `fallback: ${reason}`,
    },
  });

export async function handleLiveData(request, env = process.env, fetchImpl = fetch, index = PROJECTS) {
  const { pathname } = new URL(request.url);
  const parsed0 = parseLiveDataPath(pathname, index.defaultSlug);
  if (!parsed0 || !index.slugs.has(parsed0.slug) || !LIVE_DATA_FILES.has(parsed0.file)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  }
  const { slug, file, legacyUrl } = parsed0;
  const fallbackUrl = legacyUrl ? `/data/${file}` : `/data/${slug}/${file}`;

  const token = env.LIVE_DATA_GITHUB_TOKEN?.trim();
  if (!token) return staticFallback(fallbackUrl, "not configured");

  const repo = env.LIVE_DATA_REPO?.trim() || "fabcrowd/holderdistribution";
  const ref = env.LIVE_DATA_REF?.trim() || "main";
  const url = `https://api.github.com/repos/${repo}/contents/${repoDataPath(slug, encodeURIComponent(file), index)}?ref=${encodeURIComponent(ref)}`;

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
      console.warn(`live-data: GitHub ${upstream.status} for ${slug}/${file}`);
      return staticFallback(fallbackUrl, `upstream ${upstream.status}`);
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
    console.warn(`live-data: ${slug}/${file}: ${error?.message ?? error}`);
    return staticFallback(fallbackUrl, "error");
  }
}

export default (request) => handleLiveData(request);
