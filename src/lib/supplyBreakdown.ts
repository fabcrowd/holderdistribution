import { DEFAULT_CIRCULATING_SUBTRACT, subtractTerms } from "@/lib/circulatingSubtract";

/**
 * Groups raw supply-reconciliation categories into display buckets for the
 * holders-page SupplyBreakdown chart.
 *
 * One fixed set for every project: Retail, DEX, CEX, Developer holdings,
 * Other, Supply gap. Empty buckets are omitted. Buckets partition totalSupply:
 * counted categories + the supply gap (residual).
 *
 * Slice colours are theme tokens: retail `--primary`, DEX/CEX/Developer/Supply
 * gap `--supply-*`, Other `--muted-foreground`. Each must stay >= 3:1 against
 * --card at the donut's opacities (supplyBreakdown.test.ts enforces it).
 *
 * Developer holdings is everything held by the project's creators and not in
 * public hands. Which feed categories it holds, and what each is called, is
 * per-project config (`supply.developerHoldings.subcategories`); the feed
 * category keys (treasury, council, holdings, escrow, ...) stay intact as its
 * sub-categories, so history series keyed on them stay valid.
 *
 * Staked principal stays inside Retail. Staking reward vaults / contracts
 * (category `staking`) are developer-controlled, so they are a sub-category
 * here, not Other.
 *
 * OPEN ITEM: this grouping is display-only. It asserts nothing about whether
 * developer holdings circulate (burned supply, vesting, escrow release need
 * per-token research). The circulating figure is computed by
 * reconcile-supply and `circulatingFormula` below, unchanged.
 */

export type DisplayBucket = {
  key: string;
  label: string;
  amount: number;
  /** Retail-aligned vs institutional/project vs residual (untracked legs). */
  alignment: "retail" | "institutional" | "residual";
  color: string;
  /** Developer holdings only: non-empty sub-categories, config order. */
  subcategories?: DeveloperGroup[];
};

/** One sub-category of the Developer holdings bucket (a feed category). */
export type DeveloperGroup = { category: string; label: string; amount: number };

export type DeveloperSubcategory = { category: string; label: string };

export type DeveloperHoldingsConfig = { subcategories: DeveloperSubcategory[] };

/** Pie / legend name of the one developer-held bucket. Same for every project. */
export const DEVELOPER_BUCKET_LABEL = "Developer holdings";

/**
 * Fallback when a project config declares no `supply.developerHoldings`:
 * every feed category that is project-controlled, with generic labels.
 */
export const DEFAULT_DEVELOPER_HOLDINGS: DeveloperHoldingsConfig = {
  subcategories: [
    { category: "treasury", label: "Treasury" },
    { category: "council", label: "Council / ops Safes" },
    { category: "staking-contract", label: "Staking contract" },
    { category: "holdings", label: "Holdings" },
    { category: "team", label: "Team wallets" },
    { category: "staking", label: "Reward vaults / contracts" },
    { category: "escrow", label: "Escrow" },
  ],
};

/** Config value (possibly absent or empty) to the list the UI and grouping read. */
export const resolveDeveloperHoldings = (
  cfg: Partial<DeveloperHoldingsConfig> | undefined | null,
): DeveloperHoldingsConfig =>
  cfg?.subcategories?.length ? { subcategories: cfg.subcategories } : DEFAULT_DEVELOPER_HOLDINGS;

export const isDeveloperCategory = (cfg: DeveloperHoldingsConfig, category: string): boolean =>
  cfg.subcategories.some((s) => s.category === category);

/** Label for a feed category inside Developer holdings (falls back to the raw key). */
export const developerCategoryLabel = (cfg: DeveloperHoldingsConfig, category: string): string =>
  cfg.subcategories.find((s) => s.category === category)?.label ?? category;

/** Non-empty sub-category totals in config order. */
export const developerGroups = (
  categories: Record<string, number> | undefined | null,
  cfg: DeveloperHoldingsConfig,
): DeveloperGroup[] =>
  cfg.subcategories
    .map((s) => ({ category: s.category, label: s.label, amount: categories?.[s.category] ?? 0 }))
    .filter((g) => g.amount > 0);

/**
 * Category keys rolled into the Other base-layer row (click opens address detail).
 */
export const OTHER_CATEGORY_KEYS = [
  "safe-cluster",
  "whale-unattributed",
  "retail-whale",
  "dormant-whale",
  "excluded-unlabelled",
  "burn",
] as const;

export type OtherCategoryKey = (typeof OTHER_CATEGORY_KEYS)[number];

export const isOtherCategory = (category: string): category is OtherCategoryKey =>
  (OTHER_CATEGORY_KEYS as readonly string[]).includes(category);

/** Plain-language category labels for the Supply Breakdown Other panel. */
export const OTHER_CATEGORY_LABELS: Record<OtherCategoryKey, string> = {
  "safe-cluster": "Shared wallet group",
  "whale-unattributed": "Large wallet (not yet identified)",
  "retail-whale": "Large personal wallet",
  "dormant-whale": "Inactive large wallet",
  "excluded-unlabelled": "Small / special cases",
  burn: "Burned",
};

export const otherCategoryLabel = (category: string): string =>
  isOtherCategory(category) ? OTHER_CATEGORY_LABELS[category] : category;

/** Pie / legend name for the residual slice. Drill-down copy can be more specific. */
export const SUPPLY_GAP_LABEL = "Supply gap";

/** @deprecated Use SUPPLY_GAP_LABEL. Kept so older copy fallbacks still resolve. */
export const DEFAULT_RESIDUAL_BUCKET_LABEL = SUPPLY_GAP_LABEL;

/**
 * Fixed slice order. Every project uses these keys; zero amounts are dropped
 * so a token with nothing in a bucket does not show an empty wedge.
 */
export const CANONICAL_SUPPLY_BUCKETS = [
  "retail",
  "dex",
  "cex",
  "developer",
  "other",
  "supplyGap",
] as const;

export type CanonicalSupplyBucket = (typeof CANONICAL_SUPPLY_BUCKETS)[number];

const sumKeys = (categories: Record<string, number>, keys: readonly string[]): number =>
  keys.reduce((sum, key) => sum + (categories[key] ?? 0), 0);

/**
 * Donut fill opacities. The slice palette (`--supply-*` tokens in index.css)
 * meets 3:1 against --card down to the dimmed opacity, so none of these may
 * drop below the value the palette was tested at (supplyBreakdown.test.ts).
 */
export const DEFAULT_SLICE_OPACITY = 0.85;
export const RESIDUAL_SLICE_OPACITY = 0.8;
export const DIMMED_SLICE_OPACITY = 0.8;

export const groupSupplyCategories = (
  categories: Record<string, number> | undefined | null,
  residual = 0,
  developer: DeveloperHoldingsConfig = DEFAULT_DEVELOPER_HOLDINGS,
): DisplayBucket[] => {
  const c = categories ?? {};
  const subcategories = developerGroups(c, developer);
  const developerTotal = subcategories.reduce((sum, g) => sum + g.amount, 0);
  const other = sumKeys(c, OTHER_CATEGORY_KEYS);

  const buckets: DisplayBucket[] = [
    {
      key: "retail",
      label: "Retail",
      amount: c.retail ?? 0,
      alignment: "retail",
      color: "hsl(var(--primary))",
    },
    {
      key: "dex",
      label: "DEX",
      amount: c.dex ?? 0,
      alignment: "retail",
      color: "hsl(var(--supply-dex))",
    },
    {
      key: "cex",
      label: "CEX",
      amount: c.cex ?? 0,
      alignment: "institutional",
      color: "hsl(var(--supply-cex))",
    },
    {
      key: "developer",
      label: DEVELOPER_BUCKET_LABEL,
      amount: developerTotal,
      alignment: "institutional",
      color: "hsl(var(--supply-developer))",
      subcategories,
    },
    {
      key: "other",
      label: "Other",
      amount: other,
      alignment: "institutional",
      color: "hsl(var(--muted-foreground))",
    },
    {
      key: "supplyGap",
      label: SUPPLY_GAP_LABEL,
      amount: residual,
      alignment: "residual",
      color: "hsl(var(--supply-gap))",
    },
  ];

  return buckets.filter((b) => b.amount > 0);
};

/**
 * Parenthetical under Circulating. Names only the pieces the reconciliation
 * actually subtracts, using the Treasury slice's display name when that
 * slice is present. Escrow stays in circulating except the committed
 * override. Holdings and Team (including reward vaults) are not carved out.
 * `subtract` is the project's supply.circulating.subtract list.
 */
export const circulatingFormula = (
  categories: Record<string, number> | undefined | null,
  labels: { association: string } = { association: "Treasury" },
  escrowCommitted = 0,
  subtract: readonly string[] = DEFAULT_CIRCULATING_SUBTRACT,
): string => {
  const c = categories ?? {};
  const present = subtract.filter((k) => (c[k] ?? 0) > 0);
  const terms: string[] = subtractTerms(present, labels.association);
  if (escrowCommitted > 0) terms.push("committed escrow");
  const formula = terms.length ? `counted − ${terms.join(" − ")}` : "counted";
  const escrowLeft = (c.escrow ?? 0) - escrowCommitted;
  if (escrowCommitted > 0 && escrowLeft > 0) return `${formula}; remaining escrow included`;
  return formula;
};

/** All partition buckets (already exclude bridge-lock mirrors). */
export const partitionBuckets = (buckets: DisplayBucket[]): DisplayBucket[] => buckets;
