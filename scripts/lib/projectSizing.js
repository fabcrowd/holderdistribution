/**
 * Token-unit thresholds sized from a project's own supply target.
 *
 * The pipelines used to hard-code TEL-sized numbers (5M TEL seller floor, 1M swap
 * candidate, 100K CEX candidate, 1 TEL consistency tolerance), which are noise on
 * a 10B supply and nothing on a 1T one. Each is a fixed share of `supply.target`,
 * written as a divisor so a 100B supply yields TEL's old constants exactly (a
 * fractional multiply such as 5e-5 * 1e11 is not exact in floating point).
 *
 * Precedence at the call sites: env override > `sizing.<name>` in the project
 * config > the supply share computed here.
 */

/**
 * Floor of the consistency tolerance: treasury-history stores whole tokens while supply-reconciliation keeps
 * decimals (ONDO's treasury differs by 0.16 between them), so anything under 1 token flags rounding, not drift.
 */
const MIN_REPRESENTABLE_UNIT = 1;

const DIVISORS = Object.freeze({
  minSellerTokens: 20_000, // 0.005% of supply
  minSwapCandidateTokens: 100_000, // 0.001%
  cexCandidateMinBalance: 1_000_000, // 0.0001%
});
/** Consistency tolerance is 1e-11 of supply. */
const TOLERANCE_DIVISOR = 1e11;

export const SIZING_KEYS = Object.freeze([...Object.keys(DIVISORS), "consistencyToleranceTokens"]);

/**
 * @param {{ slug?: string, supply?: { target?: number }, sizing?: Record<string, number> }} config project config
 * @returns {{ minSellerTokens: number, minSwapCandidateTokens: number, cexCandidateMinBalance: number, consistencyToleranceTokens: number }}
 */
export function projectSizing(config) {
  const owner = `project ${config?.slug ?? "?"}`;
  const target = config?.supply?.target;
  if (!(typeof target === "number" && Number.isFinite(target) && target > 0)) {
    throw new Error(`${owner}: supply.target must be a finite number > 0 to size thresholds, got ${JSON.stringify(target)}`);
  }
  const derived = {
    minSellerTokens: target / DIVISORS.minSellerTokens,
    minSwapCandidateTokens: target / DIVISORS.minSwapCandidateTokens,
    cexCandidateMinBalance: target / DIVISORS.cexCandidateMinBalance,
    consistencyToleranceTokens: Math.max(target / TOLERANCE_DIVISOR, MIN_REPRESENTABLE_UNIT),
  };
  const overrides = config.sizing ?? {};
  for (const key of Object.keys(overrides)) {
    if (!SIZING_KEYS.includes(key)) throw new Error(`${owner}: sizing.${key} is not a known threshold (${SIZING_KEYS.join(", ")})`);
  }
  return Object.fromEntries(
    SIZING_KEYS.map((key) => {
      const override = overrides[key];
      if (override === undefined) return [key, derived[key]];
      if (!(typeof override === "number" && Number.isFinite(override) && override > 0)) {
        throw new Error(`${owner}: sizing.${key} must be a finite number > 0, got ${JSON.stringify(override)}`);
      }
      return [key, override];
    }),
  );
}
