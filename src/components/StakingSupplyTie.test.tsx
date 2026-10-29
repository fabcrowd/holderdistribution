import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { __resetActiveSlug } from "@/lib/projectStore";
import { StakingAddressList } from "./StakingAddressList";
import { StakingSupplyTie } from "./StakingSupplyTie";
import { stakingAddressLinks } from "@/lib/stakingAddresses";
import { getProject } from "@/lib/projects";

afterEach(() => __resetActiveSlug("tel"));

describe("StakingSupplyTie", () => {
  it("ties ZBCN Staking Overview to Supply and lists every staking account on Solscan", () => {
    __resetActiveSlug("zebec-network");
    const html = renderToStaticMarkup(<StakingSupplyTie />);
    expect(html).toContain('data-testid="staking-supply-tie"');
    expect(html).toContain('data-testid="staking-overview-intro"');
    expect(html).toMatch(/credited into Retail/);
    expect(html).toMatch(/not staker principal/i);
    expect(html).toMatch(/Global Staked/);
    expect(html).toMatch(/18\.9B/);
    expect(html).toContain("On-chain accounts");
    expect(html).toContain('data-testid="staking-lockup-table"');
    expect(html).toContain('href="#supply"');
    expect(html).toContain("https://solscan.io/account/zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv");
    expect(html).toContain("https://solscan.io/account/AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp");
    expect(html).toContain("https://solscan.io/account/7dvTVafoMm52sjyJCHkHZv119MecicqFCrgjq8RcLxJ6");
    expect(html).toContain("https://solscan.io/account/ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE");
    expect(html).toContain("https://solscan.io/account/DGMT79t6tVGPHW8gLH29a6G1W8AnWhc5NzddvHiU9kCy");
    expect(html).not.toContain("ZBCN_Lockup_UAT_001");
    expect(html).not.toContain("J1gA6riaPzPKFonT6Fxuwcwz1nZ8QRBHAAmx9Hyx9RTn");
    expect(html).not.toContain("D1AvWqnncqqvkVAE8f8ZtveswCU7LtqSSkMg5FfBAo9F");
    const links = stakingAddressLinks(getProject("zebec-network"));
    for (const link of links) {
      if (/UAT/i.test(link.label)) continue;
      expect(html).toContain(link.address);
    }
  });

  it("renders nothing for TEL", () => {
    __resetActiveSlug("tel");
    expect(renderToStaticMarkup(<StakingSupplyTie />)).toBe("");
  });

  it("is mounted from Staking Overview", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/WalletHoldingsWidget.tsx"), "utf8");
    expect(src).toContain("<StakingSupplyTie");
  });
});

describe("StakingAddressList", () => {
  it("prints the address as the explorer link", () => {
    const html = renderToStaticMarkup(
      <StakingAddressList
        links={[
          {
            kind: "reward-vault",
            label: "Reward vault A",
            address: "ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE",
            href: "https://solscan.io/account/ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE",
          },
        ]}
      />,
    );
    expect(html).toContain("Reward vaults");
    expect(html).toMatch(/not staker principal/i);
    expect(html).toContain('title="ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE"');
    expect(html).toContain("ErF9…3sTE");
  });
});
