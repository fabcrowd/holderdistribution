/**
 * Live CoinGecko circulating supply for one project.
 *
 * reconcile-supply.js calls this with the project's own coin id
 * (`supply.coingeckoId`, else `gated.walletFlows.coingeckoId`). A missing id,
 * a non-positive read, or a failed request leaves the comparison unset so the
 * UI hides the row. TEL is the only slug that may fall back to its traced
 * snapshot — that number is not a default for any other project.
 */
import { COINGECKO_CIRCULATING } from "./reconcileSupply.js";

export const TEL_COINGECKO_SLUG = "tel";

const COIN_URL = (id) =>
  `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;

/** CoinGecko id for this project, or null when none is configured. */
export const coingeckoIdFor = (project) => {
  const candidates = [project?.config?.supply?.coingeckoId, project?.config?.gated?.walletFlows?.coingeckoId];
  for (const id of candidates) {
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
};

const positiveSupply = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * `market_data.circulating_supply` for `id`. Throws on HTTP failure so the
 * caller can decide a fallback. Returns null when CoinGecko has no positive
 * circulating figure (including an explicit 0).
 */
export async function fetchCoingeckoCirculating(id, { fetchImpl = globalThis.fetch } = {}) {
  if (!id) return null;
  const res = await fetchImpl(COIN_URL(id), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const error = new Error(`CoinGecko ${id}: HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const body = await res.json();
  return positiveSupply(body?.market_data?.circulating_supply);
}

/**
 * Circulating supply to publish on this project's reconciliation, or null
 * when the comparison should be hidden.
 */
export async function resolveCoingeckoCirculating(project, deps = {}) {
  const id = coingeckoIdFor(project);
  if (!id) return null;
  let live = null;
  try {
    live = await fetchCoingeckoCirculating(id, deps);
  } catch (error) {
    console.warn(`CoinGecko circulating unavailable for ${project?.slug} (${id}): ${error.message}`);
  }
  if (live != null) return live;
  if (project?.slug === TEL_COINGECKO_SLUG) {
    console.warn(`CoinGecko returned no circulating supply for ${id}; keeping TEL's traced snapshot.`);
    return COINGECKO_CIRCULATING;
  }
  console.warn(`CoinGecko returned no circulating supply for ${project?.slug} (${id}); comparison hidden.`);
  return null;
}
