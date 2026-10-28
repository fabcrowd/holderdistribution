import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { methodologyFor } from "./methodology";
import { copyText } from "./projectCopy";
import { getProject, type ProjectConfig } from "./projects";
import { V3_STAKING_MODULE } from "./staking";
import { STAKED_INFO_FALLBACK, stakedPanelTip } from "./stakedPanelTip";

const abc: ProjectConfig = {
  slug: "abc",
  name: "Abacus",
  ticker: "ABC",
  supply: { target: 1_000_000_000 },
  chains: [
    {
      key: "base",
      name: "Base",
      chainId: 8453,
      explorer: "https://basescan.org",
      tokens: [{ generation: "v1", address: "0xdef", decimals: 18 }],
    },
  ],
  staking: [{ chain: "base", address: "0x5a", name: "ABC staking" }],
};

describe("stakedPanelTip", () => {
  it("uses holders.staked.info for ZBCN, including the Super App disclaimer and configured Solscan proof", () => {
    const zbcn = getProject("zebec-network");
    const tip = stakedPanelTip(zbcn);
    expect(tip.body).toBe(copyText(zbcn, "holders.staked.info", STAKED_INFO_FALLBACK));
    expect(tip.body).toMatch(/Global Staked/);
    expect(tip.body).toMatch(/18\.9B/);
    expect(tip.body).toMatch(/not current TVL/i);
    expect(tip.body).toMatch(/4\.75B/);
    expect(tip.body).toMatch(/UserStakeData/);
    expect(tip.body).toMatch(/totalStaked/);
    expect(tip.body).not.toMatch(/v3 StakingModule|Polygon/);
    expect(tip.links.map((l) => l.href)).toEqual(methodologyFor(zbcn, "staking").links.map((l) => l.href));
    expect(tip.links.map((l) => l.href)).toContain(
      "https://solscan.io/account/zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv",
    );
    expect(tip.links.map((l) => l.href)).toContain(
      "https://solscan.io/account/AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp",
    );
    for (const link of tip.links) {
      expect(link.href).toMatch(/^https:\/\/solscan\.io\/account\//);
    }
  });

  it("keeps the TEL v3/Polygon staking tip and does not leak the ZBCN disclaimer", () => {
    const tel = getProject("tel");
    const tip = stakedPanelTip(tel);
    expect(tip.body).toBe(copyText(tel, "holders.staked.info", STAKED_INFO_FALLBACK));
    expect(tip.body).toMatch(/Polygon/);
    expect(tip.body).toMatch(/v3 StakingModule/);
    expect(tip.body).toMatch(/legacy staking contract/);
    expect(tip.body).not.toMatch(/Global Staked|Super App|Solscan|18\.9B|UserStakeData/);
    expect(tip.links.map((l) => l.href)).toContain(`https://polygonscan.com/address/${V3_STAKING_MODULE}`);
    expect(tip.links.map((l) => l.href)).toContain(
      "https://polygonscan.com/address/0x92e43aec69207755cb1e6a8dc589aae630476330",
    );
    for (const link of tip.links) {
      expect(link.href).not.toMatch(/solscan\.io/);
    }
  });

  it("falls back to generic staking copy and omits proof links when none are configured", () => {
    const tip = stakedPanelTip(abc);
    expect(tip.body).toBe(copyText(abc, "holders.staked.info", STAKED_INFO_FALLBACK));
    expect(tip.body).toContain("ABC");
    expect(tip.body).not.toMatch(/v3 StakingModule|Polygon|Global Staked|Super App/);
    expect(tip.links).toEqual([]);
  });

  it("does not hardcode the TEL v3 tip in the Holders terminal", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/terminal/HoldersTerminal.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(src).toContain("<StakedPanelTip");
    expect(src).not.toMatch(/v3 StakingModule \(Polygon/);
    expect(src).not.toMatch(/Retail \$\{tk\} staked in the legacy staking contract/);
  });
});
