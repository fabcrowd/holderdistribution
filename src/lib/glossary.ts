/**
 * Plain-language definitions for the terms this dashboard uses. Rendered by
 * GlossaryDialog (header button) and reused for inline tooltips, so a term is
 * explained the same way wherever it appears.
 */
export type GlossaryTerm = { id: string; term: string; definition: string };

export const GLOSSARY: GlossaryTerm[] = [
  {
    id: "retail",
    term: "Retail holder",
    definition:
      "Any wallet holding more than 0 TEL that is not an exchange, DEX pool, Telcoin treasury/escrow wallet or a known contract. Roughly: individual holders.",
  },
  {
    id: "legacy-v3",
    term: "Legacy TEL vs TEL v3",
    definition:
      "Telcoin upgraded TEL to a new contract (v3, 18 decimals, same address on Ethereum, Polygon and Base). Holders swap 1:1. Balances here add legacy + v3 so an upgrade never looks like a sale, and total supply stays at 100B.",
  },
  {
    id: "supply",
    term: "Total supply (100B)",
    definition:
      "The fixed TEL supply. Bridged copies on Polygon and Base are backed by tokens locked on Ethereum, and swapped legacy TEL is retired, so each token is counted once.",
  },
  {
    id: "cex",
    term: "CEX",
    definition:
      "Centralised exchange (e.g. KuCoin, MEXC). CEX balance is TEL sitting in exchange-controlled wallets. Moving TEL to an exchange is often, but not always, a step before selling.",
  },
  {
    id: "dex",
    term: "DEX",
    definition:
      "Decentralised exchange (e.g. Uniswap, Balancer, ParaSwap). TEL in DEX pools is liquidity that traders buy from and sell into.",
  },
  {
    id: "escrow",
    term: "Escrow & custody",
    definition:
      "TEL held by custodians (BitGo, Anchorage) or migration contracts. It is not circulating and is excluded from retail figures.",
  },
  {
    id: "staked",
    term: "Staked TEL",
    definition: "TEL locked in the Telcoin staking contract. Stakers must unstake before upgrading to v3, so staking can fall during the migration.",
  },
  {
    id: "tier",
    term: "Balance tier",
    definition:
      "A band of wallet sizes (e.g. 1M–5M TEL). The Distribution tab shows how many wallets moved between tiers and whether TEL entered or left each tier.",
  },
  {
    id: "snapshot",
    term: "Snapshot",
    definition:
      "A point-in-time scan of every TEL balance on Ethereum, Polygon and Base. Snapshots refresh daily; the date in the header shows how current the numbers are.",
  },
  {
    id: "reclassified",
    term: "Relabeled",
    definition:
      "Shown instead of a change when a wallet was reclassified during the period (e.g. later identified as an exchange). The raw difference would mix real movement with a bookkeeping change.",
  },
];

export const glossaryTerm = (id: string): GlossaryTerm | undefined => GLOSSARY.find((t) => t.id === id);
