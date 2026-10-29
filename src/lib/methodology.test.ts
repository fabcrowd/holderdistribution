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
import { getProject, PROJECTS, type ProjectConfig } from "./projects";
import { TEL_V3_ADDRESS, legacyTokenUrl, v3TokenUrl } from "./telContracts";
import { V3_STAKING_MODULE } from "./staking";
import { copyText } from "./projectCopy";

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

  /**
   * Product rule: methodology / dual-total staking disclaimers must ship
   * evidence-backed explorer links — prose alone is not enough.
   */
  it("staking methodology overrides (and Super App dual-total disclaimers) require explorer links", () => {
    for (const entry of PROJECTS) {
      const p = getProject(entry.slug);
      const override = p.copy?.methodology?.staking;
      const stakedInfo = copyText(p, "holders.staked.info", "");
      const needsProof =
        Boolean(override) ||
        /Global Staked|not current TVL|Super App/i.test(stakedInfo);
      if (!needsProof) continue;

      const links = override?.links ?? [];
      expect(links.length, `${entry.slug}: methodology.staking.links`).toBeGreaterThan(0);
      const resolved = methodologyFor(p, "staking");
      expect(resolved.links.length, `${entry.slug}: resolved staking links`).toBeGreaterThan(0);
      for (const l of resolved.links) {
        expect(l.href, `${entry.slug}: ${l.label}`).toMatch(/^https:\/\/[^{}\s]+$/);
        expect(l.href, `${entry.slug}: ${l.label} explorer path`).toMatch(
          /\/(account|address|token)\//,
        );
      }
    }
  });

  it("ZBCN staking methodology lists Solscan program + lockup + vault ATA proof links", () => {
    const zbcn = getProject("zebec-network");
    const staking = methodologyFor(zbcn, "staking");
    expect(staking.how).toMatch(/of which/);
    expect(staking.how).toMatch(/developer-controlled and counted in Team/);
    expect(staking.how).not.toMatch(/Other/);
    expect(staking.how).toMatch(/Global Staked/);
    expect(staking.how).toMatch(/not current TVL/);
    expect(staking.verify).toMatch(/Solscan/);
    const hrefs = staking.links.map((l) => l.href);
    const required = [
      "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv",
      "BkdevFCTJvSVXBhE8NEzPFpSFdTvn9pm4zVSsLvW9ZA",
      "8bbygT4wHaR1vXQMCTK9uVnoDGBwWjNx9BUwjgLtkBvv",
      "6ucsPuczmg9uoq5i4SYDEEJ4ciKnuxW3za2sdBcKHwmw",
      "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo",
      "AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp",
      "7dvTVafoMm52sjyJCHkHZv119MecicqFCrgjq8RcLxJ6",
      "CuQBm9zdgMFw1BNcfNjb5FA1Di3z4W9AxmDuXfk8kGNU",
      "FnJhFWTiYTGSePJDKVNYQgf5XUFBJEk1rvPifj6hvb4Y",
      "DxdP5pM5BSD38C7s43aYV2BHUfKLJZq1P5673AT87HPn",
      "BcfMnwQMpv988qVCDMpJhXRyYiqchrYh9pcJPvjEypj4",
      "J1gA6riaPzPKFonT6Fxuwcwz1nZ8QRBHAAmx9Hyx9RTn",
      "D1AvWqnncqqvkVAE8f8ZtveswCU7LtqSSkMg5FfBAo9F",
    ];
    for (const addr of required) {
      expect(hrefs).toContain(`https://solscan.io/account/${addr}`);
    }
  });
});
