/**
 * TEL ecosystem Health Score (0–100) from existing holders artifacts.
 *
 * Weights (plan):
 * - 40% distribution / Gini (lower concentration → higher score)
 * - 25% DEX liquidity vs 30-day average
 * - 20% on-chain activity vs 30-day average (|Δ holders| day-to-day)
 * - 15% net holder growth over 30 days
 */

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const WEIGHTS = {
  distribution: 0.4,
  dexLiquidity: 0.25,
  activity: 0.2,
  holderGrowth: 0.15,
};

/**
 * Map Gini (0–1) to a 0–100 score. Gini 0.5 → ~100; Gini 1.0 → 0.
 * @param {number} gini
 */
export const scoreFromGini = (gini) => {
  if (!Number.isFinite(gini)) return null;
  return clamp(((1 - gini) / 0.5) * 100);
};

/**
 * Liquidity vs 30d average: equal → 50; 2× → 100; 0× → 0.
 * @param {number} current
 * @param {number} avg30
 */
export const scoreFromDexRatio = (current, avg30) => {
  if (!Number.isFinite(current) || !Number.isFinite(avg30) || avg30 <= 0) return null;
  return clamp((current / avg30) * 50);
};

/**
 * Recent |Δ holders| vs 30d mean |Δ|: equal → 50; 2× → 100.
 * @param {number} recentAbsDelta
 * @param {number} avgAbsDelta30
 */
export const scoreFromActivity = (recentAbsDelta, avgAbsDelta30) => {
  if (!Number.isFinite(recentAbsDelta) || !Number.isFinite(avgAbsDelta30)) return null;
  if (avgAbsDelta30 <= 0) return recentAbsDelta > 0 ? 75 : 50;
  return clamp((recentAbsDelta / avgAbsDelta30) * 50);
};

/**
 * 30d holder growth: 0% → 50; +10% → 100; −10% → 0.
 * @param {number} latest
 * @param {number} ago30
 */
export const scoreFromHolderGrowth = (latest, ago30) => {
  if (!Number.isFinite(latest) || !Number.isFinite(ago30) || ago30 <= 0) return null;
  const growthPct = (latest - ago30) / ago30;
  return clamp(50 + growthPct * 500);
};

/**
 * @param {object} input
 * @param {number} [input.gini]
 * @param {number} [input.dexLiquidity]
 * @param {number} [input.dexLiquidityAvg30]
 * @param {number} [input.recentAbsHolderDelta]
 * @param {number} [input.avgAbsHolderDelta30]
 * @param {number} [input.holderCount]
 * @param {number} [input.holderCountAgo30]
 */
export const computeHealthScore = (input) => {
  const components = {
    distribution: scoreFromGini(input.gini),
    dexLiquidity: scoreFromDexRatio(input.dexLiquidity, input.dexLiquidityAvg30),
    activity: scoreFromActivity(input.recentAbsHolderDelta, input.avgAbsHolderDelta30),
    holderGrowth: scoreFromHolderGrowth(input.holderCount, input.holderCountAgo30),
  };

  let weightSum = 0;
  let weighted = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const value = components[key];
    if (value == null || !Number.isFinite(value)) continue;
    weighted += value * weight;
    weightSum += weight;
  }

  const score = weightSum > 0 ? clamp(Math.round(weighted / weightSum)) : null;

  let label = "unknown";
  if (score != null) {
    if (score >= 70) label = "accumulation";
    else if (score >= 45) label = "stability";
    else label = "distribution";
  }

  return {
    score,
    label,
    weights: { ...WEIGHTS },
    components,
  };
};

/**
 * Derive inputs from holders-lite + holders-history entries.
 * @param {{ views?: { combined?: { balanceStats?: { gini?: number }, metrics?: { holderCount?: number } } } }} lite
 * @param {Array<{ date?: string, combined?: { holderCount?: number, dexLiquidity?: number } }>} historyEntries
 * @param {number} [windowDays=30]
 */
export const buildHealthScoreFromArtifacts = (lite, historyEntries, windowDays = 30) => {
  const gini = lite?.views?.combined?.balanceStats?.gini;
  const entries = Array.isArray(historyEntries) ? historyEntries.slice() : [];
  entries.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  const latest = entries[entries.length - 1];
  const holderCount =
    lite?.views?.combined?.metrics?.holderCount ?? latest?.combined?.holderCount ?? null;
  const dexLiquidity = latest?.combined?.dexLiquidity ?? null;

  const window = entries.slice(-Math.max(2, windowDays + 1));
  const dexValues = window
    .map((e) => e?.combined?.dexLiquidity)
    .filter((v) => Number.isFinite(v) && v > 0);
  const dexLiquidityAvg30 =
    dexValues.length > 0 ? dexValues.reduce((s, v) => s + v, 0) / dexValues.length : null;

  const holderSeries = window
    .map((e) => e?.combined?.holderCount)
    .filter((v) => Number.isFinite(v));
  const absDeltas = [];
  for (let i = 1; i < holderSeries.length; i++) {
    absDeltas.push(Math.abs(holderSeries[i] - holderSeries[i - 1]));
  }
  const avgAbsHolderDelta30 =
    absDeltas.length > 0 ? absDeltas.reduce((s, v) => s + v, 0) / absDeltas.length : null;
  const recentAbsHolderDelta = absDeltas.length > 0 ? absDeltas[absDeltas.length - 1] : null;

  const agoIdx = Math.max(0, entries.length - 1 - windowDays);
  const holderCountAgo30 = entries[agoIdx]?.combined?.holderCount ?? null;

  const result = computeHealthScore({
    gini,
    dexLiquidity,
    dexLiquidityAvg30,
    recentAbsHolderDelta,
    avgAbsHolderDelta30,
    holderCount,
    holderCountAgo30,
  });

  return {
    ...result,
    asOf: latest?.date ?? null,
    windowDays,
    inputs: {
      gini: gini ?? null,
      dexLiquidity,
      dexLiquidityAvg30,
      recentAbsHolderDelta,
      avgAbsHolderDelta30,
      holderCount,
      holderCountAgo30,
    },
  };
};
