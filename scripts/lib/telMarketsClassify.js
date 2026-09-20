/**
 * Pure CoinGecko ticker keep/classify helpers for TEL markets.
 * Keep in sync with supabase/functions/fetch-tel-markets/index.ts.
 */

export const MAJOR_CEXES = [
  "kucoin",
  "bybit",
  "mexc",
  "bitget",
  "bingx",
  "bingles",
  "kraken",
  "krake",
  "coinbase",
  "binance",
  "okex",
  "okx",
  "gate",
  "huobi",
  "htx",
  "bitrue",
  "bitmart",
  "bitunix",
  "blofin",
  "coinup",
  "bitkan",
  "indodax",
  "indole",
  "coinspot",
];

/** Substrings matched against CoinGecko market.identifier / name (lowercase). */
export const DEX_IDENTIFIERS = [
  "uniswap",
  "pancake",
  "sushiswap",
  "sushi",
  "curve",
  "balancer",
  "quickswap",
  "trader_joe",
  "traderjoe",
  "raydium",
  "orca",
  "dexalot",
  "spookyswap",
  "spiritswap",
  "kyber",
  "aerodrome",
  "aerodex",
  "velodrome",
  "camelot",
  "camel",
  "sundaeswap",
  "muesliswap",
  "ref_finance",
  "triton",
  "shibaswap",
  "telx",
  "swapbased",
  "baseswap",
  "alienbase",
  "thruster",
  "ramses",
  "solidly",
  "thena",
  "ambient",
  "maverick",
  "hashflow",
  "matcha",
  "1inch",
];

export const isMajorCex = (marketId, name) => {
  const identifier = (marketId || "").toLowerCase();
  const marketName = (name || "").toLowerCase();
  return MAJOR_CEXES.some(
    (cex) => identifier.includes(cex) || marketName.includes(cex),
  );
};

export const isDex = (marketId, name) => {
  if (isMajorCex(marketId, name)) return false;
  const identifier = (marketId || "").toLowerCase();
  const marketName = (name || "").toLowerCase();
  return DEX_IDENTIFIERS.some(
    (dex) => identifier.includes(dex) || marketName.includes(dex),
  );
};

export const isTrustOk = (trustScore) => {
  const score = (trustScore || "").toLowerCase();
  return score === "green" || score === "yellow";
};

export const isDisplayableTrust = (trustScore) => {
  const score = (trustScore || "").toLowerCase();
  return score === "green" || score === "yellow" || score === "red";
};

/**
 * Keep a ticker when it has positive volume + price and is either:
 * - trust green/yellow, or
 * - a major CEX (even without trust), or
 * - a recognized DEX (even without trust — CoinGecko often leaves DEX trust null).
 *
 * @param {{ marketId?: string, marketName?: string, volume?: number, price?: number, trustScore?: string|null }} ticker
 */
export const shouldKeepTicker = (ticker) => {
  const volume = Number(ticker?.volume) || 0;
  const price = Number(ticker?.price) || 0;
  if (volume <= 0 || !price) return false;

  const marketId = ticker?.marketId || "";
  const marketName = ticker?.marketName || "";
  const trustOk = isTrustOk(ticker?.trustScore);
  const mainCex = isMajorCex(marketId, marketName);
  const dex = isDex(marketId, marketName);

  return trustOk || mainCex || dex;
};

/**
 * @param {Array<{ trust_score?: string }>} markets
 */
export const marketsHaveTrustScores = (markets) =>
  (markets ?? []).some((m) => isDisplayableTrust(m?.trust_score));
