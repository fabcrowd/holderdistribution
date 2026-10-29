/**
 * Groups raw supply-reconciliation categories into display buckets for the
 * holders-page SupplyBreakdown chart.
 *
 * UX layers (progressive disclosure):
 * - Base layer: one fixed set — Retail, DEX, CEX, Treasury, Team, Holdings,
 *   Escrow, Other, Supply gap. Empty buckets are omitted.
 * - Deeper layers: click a slice for address lists, bridge math, and explorer links.
 * - Analysis layer: gated deep-dive tiles (auth) for wallets with published
 *   analysis under public/data/wallet-analysis/.
 *
 * Buckets partition totalSupply: counted categories + the supply gap (residual).
 * DEX is retail-owned (LP receipts) but protocol-custodied.
 * Supply gap is uncounted supply (TEL: bridge lock vs L2 mirrors; ZBCN: below
 * the max). The slice name is always "Supply gap"; the drill-down keeps each
 * project's explanation.
 * Treasury's title comes from project copy (`entity.association`): TEL keeps
 * "Telcoin Association-Controlled Safes"; ZBCN uses its treasury name.
 * Staked principal stays inside Retail. Leftover reward-vault balances
 * (category `staking`) fold into Other — they are not their own slice.
 */

export type DisplayBucket = {
  key: string;
  label: string;
  amount: number;
  /** Retail-aligned vs institutional/project vs residual (untracked legs). */
  alignment: "retail" | "institutional" | "residual";
  color: string;
};

/** Raw categories rolled into the Treasury bucket (drill-down keeps labels). */
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
 * Confirmed team / company wallets (TEL: Telcoin Holdings, ~1.65B). Kept as
 * its own hero bucket, distinct from the foundation (TEL: Association)
 * treasury/council/staking.
 */
export const HOLDINGS_CATEGORY_KEYS = ["holdings"] as const;

export type HoldingsCategoryKey = (typeof HOLDINGS_CATEGORY_KEYS)[number];

export const isHoldingsCategory = (category: string): category is HoldingsCategoryKey =>
  (HOLDINGS_CATEGORY_KEYS as readonly string[]).includes(category);

/**
 * Category keys rolled into the Other base-layer row (click opens address detail).
 * `staking` is leftover program custody after staker credit (reward vaults), not
 * a canonical slice.
 */
export const OTHER_CATEGORY_KEYS = [
  "safe-cluster",
  "whale-unattributed",
  "retail-whale",
  "dormant-whale",
  "excluded-unlabelled",
  "burn",
  "staking",
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
  staking: "Reward vaults",
};

export const otherCategoryLabel = (category: string): string =>
  isOtherCategory(category) ? OTHER_CATEGORY_LABELS[category] : category;

/**
 * Bucket titles for the project-controlled entities (src/lib/projectCopy.ts projectEntities).
 * `association` is the Treasury slice's display name, not a separate bucket key.
 */
export type EntityBucketLabels = {
  association: string;
  holdings: string;
  /** Team slice title. Defaults to "Team". Hidden when the category is empty. */
  team?: string;
};

/** Pie / legend name for the residual slice. Drill-down copy can be more specific. */
export const SUPPLY_GAP_LABEL = "Supply gap";

/** @deprecated Use SUPPLY_GAP_LABEL. Kept so older copy fallbacks still resolve. */
export const DEFAULT_RESIDUAL_BUCKET_LABEL = SUPPLY_GAP_LABEL;

/**
 * Raw category `staking`: program accounts that still hold tokens after
 * staker positions have been credited into retail (reward vaults). Those
 * balances fold into Other. Distinct from `staking-contract`, which rolls
 * into Treasury. Staked principal is inside Retail, not either of these.
 */
export const STAKING_CATEGORY_KEYS = ["staking"] as const;

export const isStakingCategory = (category: string): boolean =>
  (STAKING_CATEGORY_KEYS as readonly string[]).includes(category);

/** Confirmed team wallets, when a project publishes a `team` category. */
export const TEAM_CATEGORY_KEYS = ["team"] as const;

/**
 * Fixed slice order. Every project uses these keys; zero amounts are dropped
 * so a token that has no escrow (or no team) does not show an empty wedge.
 */
export const CANONICAL_SUPPLY_BUCKETS = [
  "retail",
  "dex",
  "cex",
  "treasury",
  "team",
  "holdings",
  "escrow",
  "other",
  "supplyGap",
] as const;

export type CanonicalSupplyBucket = (typeof CANONICAL_SUPPLY_BUCKETS)[number];

/** Project-agnostic fallbacks; the Supply view passes the active project's names. */
export const DEFAULT_ENTITY_BUCKET_LABELS: EntityBucketLabels = {
  association: "Treasury",
  holdings: "Holdings",
  team: "Team",
};

const sumKeys = (categories: Record<string, number>, keys: readonly string[]): number =>
  keys.reduce((sum, key) => sum + (categories[key] ?? 0), 0);

export const groupSupplyCategories = (
  categories: Record<string, number> | undefined | null,
  residual = 0,
  labels: EntityBucketLabels = DEFAULT_ENTITY_BUCKET_LABELS,
): DisplayBucket[] => {
  const c = categories ?? {};
  const treasury = sumKeys(c, ASSOCIATION_CATEGORY_KEYS);
  const team = sumKeys(c, TEAM_CATEGORY_KEYS);
  const holdings = sumKeys(c, HOLDINGS_CATEGORY_KEYS);
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
      color: "hsl(152 60% 42%)",
    },
    {
      key: "cex",
      label: "CEX",
      amount: c.cex ?? 0,
      alignment: "institutional",
      color: "hsl(32 90% 50%)",
    },
    {
      key: "treasury",
      label: labels.association,
      amount: treasury,
      alignment: "institutional",
      color: "hsl(250 45% 50%)",
    },
    {
      key: "team",
      label: labels.team ?? "Team",
      amount: team,
      alignment: "institutional",
      color: "hsl(12 70% 48%)",
    },
    {
      key: "holdings",
      label: labels.holdings,
      amount: holdings,
      alignment: "institutional",
      color: "hsl(330 55% 48%)",
    },
    {
      key: "escrow",
      label: "Escrow",
      amount: c.escrow ?? 0,
      alignment: "institutional",
      color: "hsl(200 60% 45%)",
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
      color: "hsl(0 0% 55%)",
    },
  ];

  return buckets.filter((b) => b.amount > 0);
};

/**
 * Parenthetical under Circulating. Names only the pieces the reconciliation
 * actually subtracts, using the Treasury slice's display name when that
 * slice is present. Escrow stays in circulating except the committed
 * override. Holdings, Team, and reward vaults (inside Other) are not carved out.
 */
export const circulatingFormula = (
  categories: Record<string, number> | undefined | null,
  labels: Pick<EntityBucketLabels, "association"> = DEFAULT_ENTITY_BUCKET_LABELS,
  escrowCommitted = 0,
): string => {
  const c = categories ?? {};
  const treasuryOut = (c.treasury ?? 0) + (c.council ?? 0);
  const terms: string[] = [];
  if (treasuryOut > 0) terms.push(labels.association || "Treasury");
  if (escrowCommitted > 0) terms.push("committed escrow");
  const formula = terms.length ? `counted − ${terms.join(" − ")}` : "counted";
  const escrowLeft = (c.escrow ?? 0) - escrowCommitted;
  if (escrowCommitted > 0 && escrowLeft > 0) return `${formula}; remaining escrow included`;
  return formula;
};

/** All partition buckets (already exclude bridge-lock mirrors). */
export const partitionBuckets = (buckets: DisplayBucket[]): DisplayBucket[] => buckets;
