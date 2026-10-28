/** Page titles / descriptions for the landing page and token routes. */

/** The site name, as already used by index.html's <title>. */
export const SITE_TITLE = "Holder Distribution | Token Holder Analytics & Supply Data";

export const SITE_DESCRIPTION =
  "Real, on-chain holder distribution, supply breakdown, and exchange flow data for crypto tokens — a source of truth for the community, not the project team.";

export const tokenPageTitle = (p: { name: string; ticker: string }): string => `${p.name} (${p.ticker}) holder distribution`;

export const tokenPageDescription = (p: { ticker: string }): string =>
  `${p.ticker} tokenomics: circulating supply breakdown, holder distribution and tiers, exchange flows, and historical growth from real-time on-chain data.`;
