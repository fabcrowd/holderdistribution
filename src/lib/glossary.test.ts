import { describe, expect, it } from "vitest";
import { GLOSSARY, buildGlossary, glossaryTerm } from "./glossary";
import { getProject, type ProjectConfig } from "./projects";

// The TEL glossary as it read before copy became project-driven. TEL's
// rendered text must not change: generic templates + tel.json copy.glossary
// overrides have to reproduce it exactly.
const TEL_GLOSSARY_BEFORE = [
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

const fakeProject: ProjectConfig = {
  slug: "abc",
  name: "Abacus",
  ticker: "ABC",
  supply: { target: 21_000_000 },
  chains: [
    { key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io", tokens: [{ generation: "v1", address: "0x0", decimals: 18 }] },
    { key: "arbitrum", name: "Arbitrum", chainId: 42161, explorer: "https://arbiscan.io", tokens: [{ generation: "v1", address: "0x0", decimals: 18 }] },
  ],
};

describe("glossary", () => {
  it("has unique ids and non-empty plain-language definitions", () => {
    const ids = GLOSSARY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of GLOSSARY) {
      expect(t.term.length).toBeGreaterThan(1);
      expect(t.definition.length).toBeGreaterThan(40);
    }
  });
  it("covers the terms a newcomer hits first", () => {
    for (const id of ["retail", "legacy-v3", "cex", "dex", "escrow", "staked"]) expect(glossaryTerm(id)).toBeDefined();
  });
  it("renders TEL's glossary exactly as before (templates + tel.json overrides)", () => {
    expect(buildGlossary(getProject("tel"))).toEqual(TEL_GLOSSARY_BEFORE);
    expect(GLOSSARY).toEqual(TEL_GLOSSARY_BEFORE);
  });
  it("fills every term from another project's config, with no TEL leakage", () => {
    const g = buildGlossary(fakeProject);
    const text = g.map((t) => `${t.term} ${t.definition}`).join("\n");
    expect(text).not.toMatch(/\bTEL\b|Telcoin|\{(ticker|name|chains|supply)\}/);
    expect(glossaryTerm("supply", g)?.term).toBe("Total supply (21M)");
    expect(glossaryTerm("staked", g)?.term).toBe("Staked ABC");
    expect(glossaryTerm("snapshot", g)?.definition).toContain("every ABC balance on Ethereum and Arbitrum");
    expect(glossaryTerm("retail", g)?.definition).toContain("Abacus treasury");
  });
  it("lists the token-generation term only for multi-generation projects", () => {
    expect(glossaryTerm("legacy-v3", buildGlossary(fakeProject))).toBeUndefined();
    expect(glossaryTerm("legacy-v3", buildGlossary(getProject("tel")))?.term).toBe("Legacy TEL vs TEL v3");
  });
});
