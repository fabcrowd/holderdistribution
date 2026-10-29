/**
 * Circulating-supply definition, per project. Mirrors
 * scripts/lib/circulatingSubtract.js (parity-tested); config key
 * `supply.circulating.subtract` lists the category keys held out of
 * circulating, defaulting to TEL's historical definition when omitted.
 */
export const DEFAULT_CIRCULATING_SUBTRACT: readonly string[] = ["treasury", "council"];

export const resolveCirculatingSubtract = (
  supply: { circulating?: { subtract?: string[] } } | undefined | null,
): string[] => {
  const raw = supply?.circulating?.subtract;
  if (raw === undefined || raw === null) return [...DEFAULT_CIRCULATING_SUBTRACT];
  return [...new Set(raw.map((k) => k.trim()))];
};

const CATEGORY_LABELS: Record<string, string> = {
  treasury: "Treasury",
  council: "Council / ops Safes",
  escrow: "Escrow",
  holdings: "Holdings",
  team: "Team wallets",
  staking: "Reward contracts",
  cex: "Exchange wallets",
  dex: "DEX liquidity",
};

/**
 * Display name for one subtracted category. Treasury and council collapse
 * into the project's association label (what the Supply view calls that
 * slice); other keys use a fixed label, else the raw key.
 */
export const subtractLabel = (category: string, association: string): string =>
  category === "treasury" || category === "council" ? association || "Treasury" : (CATEGORY_LABELS[category] ?? category);

/** Unique display terms for the subtract list, in config order. */
export const subtractTerms = (subtract: readonly string[], association: string): string[] => [
  ...new Set(subtract.map((k) => subtractLabel(k, association))),
];

/**
 * One-sentence definition shown beside the Circulating figure, generated from
 * the same list reconcile-supply subtracts so the copy cannot drift.
 */
export const circulatingDefinition = (subtract: readonly string[], association: string): string => {
  const terms = subtractTerms(subtract, association);
  const base = terms.length
    ? `Circulating = counted supply − ${terms.join(" − ")}`
    : "Circulating = counted supply";
  return `${base}, less any wallet-level non-circulating override (committed escrow).`;
};
