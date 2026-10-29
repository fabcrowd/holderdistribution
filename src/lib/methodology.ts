/**
 * Per-section methodology copy for the "how this works / verify on-chain"
 * hover cards. Everything shown on the site is reconstructed from public
 * on-chain data, so each section links to where a skeptic can check it
 * themselves on a block explorer.
 *
 * The generic text below is written once for any mapped project and filled
 * from its config ({ticker}/{name}/{chains}/{supply}); its links are derived
 * from the config's token and staking contracts. A project with facts that
 * have no generic phrasing (TEL's legacy→v3 upgrade, named custodians, the
 * CoinGecko trace, specific DEX pools) overrides a section in
 * config/projects/<slug>.json under `copy.methodology.<key>`. Override link
 * hrefs may use `{token:<chainKey>:<generation>}` (that token's explorer page)
 * and `{explorer:<chainKey>}` (the chain's explorer origin), so addresses stay
 * in one place.
 */
import type { ProjectConfig } from "@/lib/projects";
import { copyContext, fillCopy } from "@/lib/projectCopy";
import { chainExplorerLink, explorerRoot } from "@/lib/explorerLinks";

export type MethodologyLink = { label: string; href: string };
export type Methodology = { how: string; verify: string; links: MethodologyLink[] };

type LinkSet = "tokens" | "staking";
type GenericMethodology = { how: string; verify: string; links: LinkSet[] };

export const METHODOLOGY_KEYS = [
  "circulatingSupply",
  "holderSnapshot",
  "balanceInsights",
  "concentration",
  "holderMomentum",
  "staking",
  "overlap",
  "cexFlows",
  "distribution",
  "dexSwaps",
  "supplyBreakdown",
] as const;
export type MethodologyKey = (typeof METHODOLOGY_KEYS)[number];

/** Project-agnostic methodology; placeholders filled from the active project. */
export const GENERIC_METHODOLOGY: Record<MethodologyKey, GenericMethodology> = {
  circulatingSupply: {
    how: "This box shows the circulating supply reported by a third-party aggregator, not a figure we compute. The Supply Breakdown reconstructs circulating supply directly from on-chain balances instead, so the two can differ.",
    verify: "Compare the aggregator's figure with the Supply Breakdown, whose buckets are built from on-chain balances you can check on the explorer.",
    links: ["tokens"],
  },
  holderSnapshot: {
    how: "Every wallet's {ticker} balance is reconstructed from the token's on-chain Transfer event logs on {chains}, read directly from full nodes (the same ledger the block explorers use). A holder is any wallet with a non-zero balance, with no minimum applied, so every holder count on this page reconciles to the same total.",
    verify: "Open the {ticker} token contract on any explorer and check the Holders tab, or look up any single wallet's {ticker} balance directly.",
    links: ["tokens", "staking"],
  },
  balanceInsights: {
    how: "Average, median, percentiles and the Gini coefficient are computed over the reconstructed on-chain balances of retail wallets (exchange & hot wallets excluded).",
    verify: "Balances come straight from the {ticker} token contract — spot-check any wallet's holdings on the explorer.",
    links: ["tokens"],
  },
  concentration: {
    how: "Retail wallets are ranked by balance and the top-N cohorts' combined holdings summed. Exchange & hot wallets are excluded so a custody pool is never counted as a whale.",
    verify: "The token's Holders tab on the explorer lists every wallet by balance, largest first.",
    links: ["tokens"],
  },
  holderMomentum: {
    how: "Holder counts and first-time wallets are derived from weekly on-chain snapshots of every wallet holding >0 {ticker}.",
    verify: "The Holders count on the token contract page reflects the same on-chain set.",
    links: ["tokens"],
  },
  staking: {
    how: "Staked {ticker} is read on-chain from the {name} staking contracts and mapped back to each staker's wallet, counted once per staker. Staked {ticker} is already part of each staker's retail balance, so it is never added on top of Retail Held.",
    verify: "Open the staking contract on the explorer to inspect staked positions and transactions.",
    links: ["staking", "tokens"],
  },
  overlap: {
    how: "Wallets that hold {ticker} on more than one chain are matched by address across the per-chain snapshots.",
    verify: "Look up the same wallet address on each chain's explorer to see its balance on each.",
    links: ["tokens"],
  },
  cexFlows: {
    how: "Deposits to and withdrawals from known exchange hot wallets are counted directly from {ticker} Transfer logs. Trading happens off-chain in the exchange's private ledger, so this shows supply moving toward/away from the market — not realized sales. When wallets are re-labelled into the exchange set, that step is a classification change, not an inflow.",
    verify: "Every exchange wallet is a real on-chain address (expand a row to see them); all transfers to and from it are public on the explorer.",
    links: ["tokens"],
  },
  distribution: {
    how: "Retail wallets are bucketed by balance range (exchange & hot wallets excluded). Tier movement tracks the SAME wallet across weekly snapshots, and each outgoing transfer is classified from the Transfer logs: into a DEX pool as a swap = sold, into a pool as liquidity provision = added to LP (not a sale), to an exchange wallet = deposit, to another wallet = moved/split. Incoming transfers reverse those labels (bought / unstaked from LP / from exchange / from wallet).",
    verify: "Balances and every transfer are public on the {ticker} token contract; the DEX pool and exchange addresses used are themselves on-chain and linkable.",
    links: ["tokens"],
  },
  dexSwaps: {
    how: "Swaps are counted from {ticker} Transfer logs into and out of on-chain DEX liquidity pools. {ticker} sent into a pool is swapped for another coin (a sale); {ticker} sent out is a buy. Liquidity provision (adding/removing LP) is tracked separately from swaps — depositing {ticker} into a pool is not a sale, and withdrawing LP is not a buy.",
    verify: "Open a pool contract on the explorer to see its {ticker} transfers in and out — each swap is a public transaction.",
    links: ["tokens"],
  },
  supplyBreakdown: {
    how: "Total supply is {supply}. We split it into one fixed set — Retail, DEX, CEX, Treasury, Team, Holdings, Escrow, Other, and Supply gap — and hide any bucket that is empty, so the pieces add to the total. Staked balances stay inside Retail. Each bucket is built from on-chain balances of labelled addresses; click a bucket for address-level drill-down.",
    verify: "Base layer: the chart and bucket list. Click a bucket for its address list and explorer links.",
    links: ["tokens", "staking"],
  },
};

/** "Etherscan" from "https://etherscan.io", "Basescan" from "https://basescan.org". */
export const explorerName = (explorer: string): string => {
  const host = explorer.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/:]/)[0] ?? "";
  const base = host.split(".")[0] ?? "";
  return base ? base[0].toUpperCase() + base.slice(1) : "explorer";
};

type LinkProject = Pick<ProjectConfig, "ticker" | "chains" | "staking">;

const chainFor = (p: LinkProject, chainKey: string) => p.chains.find((c) => c.key === chainKey);

/** Each chain's canonical token (or its only token) on that chain's explorer. */
export const projectTokenLinks = (p: LinkProject): MethodologyLink[] =>
  p.chains.flatMap((c) => {
    const token = c.tokens.find((t) => t.status === "canonical") ?? c.tokens[0];
    const root = explorerRoot(c); // Solana defaults to Solscan
    if (!token || !root) return [];
    return [{ label: `${p.ticker} on ${explorerName(root)}`, href: chainExplorerLink(c, "token", token.address) }];
  });

export const projectStakingLinks = (p: LinkProject): MethodologyLink[] =>
  (p.staking ?? []).flatMap((s) => {
    const chain = chainFor(p, s.chain);
    return chain && explorerRoot(chain) ? [{ label: s.name, href: chainExplorerLink(chain, "address", s.address) }] : [];
  });

const HREF_PLACEHOLDER = /\{(token|explorer):([a-z0-9-]+)(?::([a-z0-9-]+))?\}/g;

/** Resolves {token:<chain>:<generation>} and {explorer:<chain>}; unknown ones are left as-is. */
export const resolveHref = (p: LinkProject, href: string): string =>
  href.replace(HREF_PLACEHOLDER, (whole, kind: string, chainKey: string, generation?: string) => {
    const chain = p.chains.find((c) => c.key === chainKey);
    if (!chain || !explorerRoot(chain)) return whole;
    if (kind === "explorer") return explorerRoot(chain);
    const token = chain.tokens.find((t) => t.generation === generation);
    return token ? chainExplorerLink(chain, "token", token.address) : whole;
  });

type MethodologyProject = Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "staking" | "copy">;

/** Methodology for one section of one project: its override when it has one, else the generic text. */
export const methodologyFor = (p: MethodologyProject, key: MethodologyKey): Methodology => {
  const ctx = copyContext(p);
  const generic = GENERIC_METHODOLOGY[key];
  const override = p.copy?.methodology?.[key];
  const links = override?.links
    ? override.links.map((l) => ({ label: fillCopy(l.label, ctx), href: resolveHref(p, l.href) }))
    : generic.links.flatMap((set) => (set === "tokens" ? projectTokenLinks(p) : projectStakingLinks(p)));
  return {
    how: fillCopy(override?.how ?? generic.how, ctx),
    verify: fillCopy(override?.verify ?? generic.verify, ctx),
    links,
  };
};
