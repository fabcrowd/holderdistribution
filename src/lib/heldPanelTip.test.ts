import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCompact } from "./format";
import { copyText } from "./projectCopy";
import { getProject, type ProjectConfig } from "./projects";
import { HELD_INFO_FALLBACK, heldPanelTip } from "./heldPanelTip";

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
};

describe("heldPanelTip", () => {
  it("uses holders.held.info for ZBCN and does not claim staked tokens are inside retail", () => {
    const zbcn = getProject("zebec-network");
    const tip = heldPanelTip(zbcn, { stakedTotal: 4.75e9, stakedV3: 4.75e9 });
    expect(tip).toBe(copyText(zbcn, "holders.held.info", HELD_INFO_FALLBACK));
    expect(tip).toMatch(/own bucket/);
    expect(tip).toMatch(/not included in this Retail line/);
    expect(tip).not.toMatch(/v3 StakingModule|Polygon/);
    expect(tip).not.toMatch(/Retail includes|already counted|credited to each staker|subset of Retail/i);
  });

  it("keeps the TEL held tip, including the live v3 StakingModule figures", () => {
    const tel = getProject("tel");
    const stakedTotal = 12.34e9;
    const stakedV3 = 4.5e9;
    const tip = heldPanelTip(tel, { stakedTotal, stakedV3 });
    expect(tip).toBe(
      `TEL in retail wallets compared with TEL in custody at known exchange wallets. All chains combined. Retail includes ${formatCompact(stakedTotal)} staked TEL, of which ${formatCompact(stakedV3)} is in the v3 StakingModule (credited to each staker's wallet, so it isn't counted twice).`,
    );
    expect(tip).not.toMatch(/Global Staked|Super App|own bucket/);
  });

  it("omits TEL's v3 clause until the v3 figure exists", () => {
    const tel = getProject("tel");
    const tip = heldPanelTip(tel, { stakedTotal: 12e9, stakedV3: null });
    expect(tip).toBe("TEL in retail wallets compared with TEL in custody at known exchange wallets. All chains combined.");
    expect(tip).not.toMatch(/StakingModule/);
  });

  it("falls back to retail-vs-exchange copy with no staking claim", () => {
    const tip = heldPanelTip(abc, { stakedTotal: 10, stakedV3: 10 });
    expect(tip).toBe("ABC in retail wallets compared with ABC in custody at known exchange wallets. All chains combined.");
    expect(tip).not.toMatch(/v3 StakingModule|Polygon|Retail includes|own bucket/);
  });

  it("does not hardcode the TEL v3 held sentence in the Holders terminal", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/terminal/HoldersTerminal.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(src).toContain("heldPanelTip(");
    expect(src).not.toMatch(/credited to each staker's wallet/);
    expect(src).not.toMatch(/Retail includes \$\{formatCompact/);
  });
});
