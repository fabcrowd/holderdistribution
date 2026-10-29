/**
 * Circulating-supply definition, per project.
 *
 * config/projects/<slug>.json `supply.circulating.subtract` lists the
 * reconciliation category keys held out of circulating. Projects that omit it
 * get the default below (TEL's historical definition). nonCirculatingOverride
 * on individual labels is applied on top, independent of this list.
 *
 * Mirrored by src/lib/circulatingSubtract.ts (parity-tested).
 */
export const DEFAULT_CIRCULATING_SUBTRACT = Object.freeze(["treasury", "council"]);

/** Config list -> validated, de-duplicated category keys (default when absent). */
export const resolveCirculatingSubtract = (supply) => {
  const raw = supply?.circulating?.subtract;
  if (raw === undefined || raw === null) return [...DEFAULT_CIRCULATING_SUBTRACT];
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string" || !k.trim())) {
    throw new Error("supply.circulating.subtract must be an array of category keys");
  }
  return [...new Set(raw.map((k) => k.trim()))];
};

/** Sum of the named categories' balances. */
export const subtractedTotal = (categories, subtract) =>
  [...new Set(subtract)].reduce((sum, key) => sum + (Number(categories?.[key]) || 0), 0);
