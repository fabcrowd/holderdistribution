import { describe, expect, it } from "vitest";
import {
  GENERIC_METHODOLOGY,
  METHODOLOGY_KEYS,
  explorerName,
  methodologyFor,
  projectStakingLinks,
  projectTokenLinks,
  resolveHref,
} from "./methodology";
import { getProject, type ProjectConfig } from "./projects";
import { TEL_V3_ADDRESS, legacyTokenUrl, v3TokenUrl } from "./telContracts";
import { V3_STAKING_MODULE } from "./staking";

const abc: ProjectConfig = {
  slug: "abc",
  name: "Abacus",
  ticker: "ABC",
  supply: { target: 1_000_000_000 },
  chains: [
    { key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io", tokens: [{ generation: "v1", address: "0xabc", decimals: 18 }] },
    { key: "base", name: "Base", chainId: 8453, explorer: "https://basescan.org", tokens: [{ generation: "v1", address: "0xdef", decimals: 18 }] },
  ],
  staking: [{ chain: "base", address: "0x5a", name: "ABC staking" }],
};

describe("methodology", () => {
  it("names explorers from their origin", () => {
    expect(explorerName("https://etherscan.io")).toBe("Etherscan");
    expect(explorerName("https://polygonscan.com")).toBe("Polygonscan");
    expect(explorerName("https://www.basescan.org/")).toBe("Basescan");
  });

  it("resolves {token:…} and {explorer:…} hrefs from project config", () => {
    const tel = getProject("tel");
    expect(resolveHref(tel, "{token:ethereum:legacy}")).toBe(legacyTokenUrl("ethereum"));
    expect(resolveHref(tel, "{token:base:v3}")).toBe(v3TokenUrl("base"));
    expect(resolveHref(tel, "{explorer:polygon}/address/0x1")).toBe("https://polygonscan.com/address/0x1");
    expect(resolveHref(tel, "{token:solana:v3}")).toBe("{token:solana:v3}");
  });

  it("TEL keeps its specific methodology (legacy+v3, staking module, CoinGecko trace) from config", () => {
    const tel = getProject("tel");
    const snap = methodologyFor(tel, "holderSnapshot");
    expect(snap.how).toMatch(/legacy TEL \(2 decimals\) plus its upgraded TEL v3/);
    expect(snap.links[0]).toEqual({ label: "TEL on Etherscan", href: legacyTokenUrl("ethereum") });
    expect(snap.links.map((l) => l.href)).toContain(v3TokenUrl("ethereum"));
    const staking = methodologyFor(tel, "staking");
    expect(staking.how).toMatch(/TEL v3 StakingModule \(live since 1 Sep 2026/);
    expect(staking.links.map((l) => l.href)).toContain(`https://polygonscan.com/address/${V3_STAKING_MODULE}`);
    expect(methodologyFor(tel, "circulatingSupply").how).toMatch(/Anchorage Digital Vault/);
    expect(methodologyFor(tel, "supplyBreakdown").how).toMatch(/Telcoin Association-Controlled Safes/);
  });

  it("every TEL override is a known section and every link resolves", () => {
    const tel = getProject("tel");
    for (const key of Object.keys(tel.copy?.methodology ?? {})) {
      expect(METHODOLOGY_KEYS as readonly string[]).toContain(key);
    }
    for (const key of METHODOLOGY_KEYS) {
      const m = methodologyFor(tel, key);
      expect(m.how.length, key).toBeGreaterThan(20);
      for (const l of m.links) expect(l.href, `${key}: ${l.label}`).toMatch(/^https:\/\/[^{}]+$/);
    }
    expect(TEL_V3_ADDRESS).toMatch(/^0x/);
  });

  it("other projects get the generic text with config-derived links, never TEL wording", () => {
    for (const key of METHODOLOGY_KEYS) {
      const m = methodologyFor(abc, key);
      const all = `${m.how} ${m.verify} ${m.links.map((l) => `${l.label} ${l.href}`).join(" ")}`;
      expect(all, key).not.toMatch(/\bTEL\b|Telcoin|Anchorage|BitGo|KuCoin|\{(ticker|name|chains|supply)\}/);
    }
    expect(methodologyFor(abc, "holderSnapshot").how).toContain("ABC balance");
    expect(methodologyFor(abc, "holderSnapshot").how).toContain("Ethereum and Base");
    expect(methodologyFor(abc, "supplyBreakdown").how).toContain("Total supply is 1B");
    expect(projectTokenLinks(abc)).toEqual([
      { label: "ABC on Etherscan", href: "https://etherscan.io/token/0xabc" },
      { label: "ABC on Basescan", href: "https://basescan.org/token/0xdef" },
    ]);
    expect(projectStakingLinks(abc)).toEqual([{ label: "ABC staking", href: "https://basescan.org/address/0x5a" }]);
    expect(methodologyFor(abc, "staking").links[0].label).toBe("ABC staking");
  });

  it("has a generic entry for every section", () => {
    expect(Object.keys(GENERIC_METHODOLOGY).sort()).toEqual([...METHODOLOGY_KEYS].sort());
  });
});
