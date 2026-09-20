/**
 * Groups raw supply-reconciliation categories into display buckets for the
 * holders-page SupplyBreakdown chart.
 *
 * UX layers (progressive disclosure):
 * - Base layer: Retail, CEX, Association, Holdings, Other, In transit, …
 * - Deeper layers: click Association / Holdings / Other / In transit for
 *   address lists, bridge math, and explorer links.
 * - Analysis layer: gated deep-dive tiles (auth) for wallets with published
 *   analysis under public/data/wallet-analysis/.
 *
 * Buckets partition totalSupply (100B): counted categories + residual.
 * DEX Liquidity is retail-owned (LP receipts) but protocol-custodied.
 * Residual is bridge lock vs L2 mirrors / origin scan drift — not a wallet pool.
 */

export type DisplayBucket = {
  key: string;
  label: string;
  amount: number;
  /** Retail-aligned vs institutional/project vs residual (untracked legs). */
  alignment: "retail" | "institutional" | "residual";
  color: string;
};

/** Raw categories rolled into the Association hero bucket (drill-down keeps labels). */
export const ASSOCIATION_CATEGORY_KEYS = [
  "treasury",
  "council",
  "staking-contract",
] as const;

export type AssociationCategoryKey = (typeof ASSOCIATION_CATEGORY_KEYS)[number];

export const isAssociationCategory = (
  category: string,
): category is AssociationCategoryKey =>
  (ASSOCIATION_CATEGORY_KEYS as readonly string[]).includes(category);

/** Plain-language subcategory labels inside the Association drill-down. */
export const ASSOCIATION_CATEGORY_LABELS: Record<AssociationCategoryKey, string> = {
  treasury: "Treasury",
  council: "Council / ops Safes",
  "staking-contract": "Staking contract",
};

export const associationCategoryLabel = (category: string): string =>
  isAssociationCategory(category) ? ASSOCIATION_CATEGORY_LABELS[category] : category;

/**
 * Confirmed Telcoin Holdings wallets (~1.65B). Kept as its own hero bucket —
 * same legal/ops cluster as the former safe-cluster set, distinct from
 * Association treasury/council/staking.
 */
export const HOLDINGS_CATEGORY_KEYS = ["holdings"] as const;

export type HoldingsCategoryKey = (typeof HOLDINGS_CATEGORY_KEYS)[number];

export const isHoldingsCategory = (category: string): category is HoldingsCategoryKey =>
  (HOLDINGS_CATEGORY_KEYS as readonly string[]).includes(category);

/** Category keys rolled into the Other base-layer row (click opens address detail). */
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

export const groupSupplyCategories = (
  categories: Record<string, number> | undefined | null,
  residual = 0,
): DisplayBucket[] => {
  const c = categories ?? {};
  const association = ASSOCIATION_CATEGORY_KEYS.reduce((sum, k) => sum + (c[k] ?? 0), 0);
  const holdings = HOLDINGS_CATEGORY_KEYS.reduce((sum, k) => sum + (c[k] ?? 0), 0);
  const other = OTHER_CATEGORY_KEYS.reduce((sum, k) => sum + (c[k] ?? 0), 0);

  const buckets: DisplayBucket[] = [
    {
      key: "retail",
      label: "Retail (wallets)",
      amount: c.retail ?? 0,
      alignment: "retail",
      color: "hsl(var(--primary))",
    },
    {
      key: "dex",
      label: "DEX Liquidity",
      amount: c.dex ?? 0,
      alignment: "retail",
      color: "hsl(152 60% 42%)",
    },
    {
      key: "cex",
      label: "CEX Custody",
      amount: c.cex ?? 0,
      alignment: "institutional",
      color: "hsl(32 90% 50%)",
    },
    {
      key: "escrow",
      label: "Escrow",
      amount: c.escrow ?? 0,
      alignment: "institutional",
      color: "hsl(200 60% 45%)",
    },
    {
      key: "association",
      label: "Telcoin Association-Controlled Safes",
      amount: association,
      alignment: "institutional",
      color: "hsl(250 45% 50%)",
    },
    {
      key: "holdings",
      label: "Telcoin Holdings",
      amount: holdings,
      alignment: "institutional",
      color: "hsl(165 42% 38%)",
    },
    {
      key: "other",
      label: "Other",
      amount: other,
      alignment: "institutional",
      color: "hsl(var(--muted-foreground))",
    },
    {
      key: "residual",
      label: "In transit (bridges)",
      amount: residual,
      alignment: "residual",
      color: "hsl(0 0% 55%)",
    },
  ];

  return buckets.filter((b) => b.amount > 0);
};

/** All partition buckets (already exclude bridge-lock mirrors). */
export const partitionBuckets = (buckets: DisplayBucket[]): DisplayBucket[] => buckets;
