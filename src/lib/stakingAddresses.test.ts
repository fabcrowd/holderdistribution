import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCompact } from "./format";
import { getProject } from "./projects";
import { V3_STAKING_MODULE } from "./staking";
import { groupStakingAccounts, stakingAddressKind, stakingAddressLinks, supplyRetailStakeModel } from "./stakingAddresses";

const PROGRAM = "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv";
const LOCKUPS = [
  "BkdevFCTJvSVXBhE8NEzPFpSFdTvn9pm4zVSsLvW9ZA",
  "6ucsPuczmg9uoq5i4SYDEEJ4ciKnuxW3za2sdBcKHwmw",
  "AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp",
  "CuQBm9zdgMFw1BNcfNjb5FA1Di3z4W9AxmDuXfk8kGNU",
  "DxdP5pM5BSD38C7s43aYV2BHUfKLJZq1P5673AT87HPn",
  "J1gA6riaPzPKFonT6Fxuwcwz1nZ8QRBHAAmx9Hyx9RTn",
];
const STAKE_VAULT_ATAS = [
  "8bbygT4wHaR1vXQMCTK9uVnoDGBwWjNx9BUwjgLtkBvv",
  "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo",
  "7dvTVafoMm52sjyJCHkHZv119MecicqFCrgjq8RcLxJ6",
  "FnJhFWTiYTGSePJDKVNYQgf5XUFBJEk1rvPifj6hvb4Y",
  "BcfMnwQMpv988qVCDMpJhXRyYiqchrYh9pcJPvjEypj4",
  "D1AvWqnncqqvkVAE8f8ZtveswCU7LtqSSkMg5FfBAo9F",
];
const REWARD_VAULT_ATAS = ["ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE", "DGMT79t6tVGPHW8gLH29a6G1W8AnWhc5NzddvHiU9kCy"];

describe("stakingAddressLinks", () => {
  it("lists the ZBCN program, every lockup, every stake-vault ATA, and both reward vaults", () => {
    const zbcn = getProject("zebec-network");
    const links = stakingAddressLinks(zbcn);
    const byKind = (kind: string) => links.filter((link) => link.kind === kind).map((link) => link.address);

    expect(byKind("program")).toEqual([PROGRAM]);
    expect(byKind("lockup")).toEqual(LOCKUPS);
    expect(byKind("stake-vault")).toEqual(STAKE_VAULT_ATAS);
    expect(byKind("reward-vault")).toEqual(REWARD_VAULT_ATAS);

    const stakingContracts = (zbcn.chains[0].contracts ?? {});
    for (const entry of Object.values(stakingContracts)) {
      if (entry.role !== "staking") continue;
      expect(links.map((link) => link.address)).toContain(entry.address);
    }
    for (const link of links) {
      expect(link.href).toBe(`https://solscan.io/account/${link.address}`);
    }
  });

  it("keeps TEL staking contracts on Polygonscan and does not invent a retail callout", () => {
    const tel = getProject("tel");
    const links = stakingAddressLinks(tel);
    expect(links.map((link) => link.address)).toContain(V3_STAKING_MODULE);
    expect(links.map((link) => link.address)).toContain("0x92e43aec69207755cb1e6a8dc589aae630476330");
    expect(links.every((link) => link.href.startsWith("https://polygonscan.com/address/"))).toBe(true);
    expect(links.some((link) => link.kind === "reward-vault")).toBe(false);

    const model = supplyRetailStakeModel(tel, 12e9, formatCompact);
    expect(model).toEqual({ note: null, body: null, principalLinks: [], rewardLinks: [] });
  });

  it("pairs production lockups with vault ATAs and hides UAT from the public group", () => {
    const grouped = groupStakingAccounts(stakingAddressLinks(getProject("zebec-network")));
    expect(grouped.program?.address).toBe(PROGRAM);
    expect(grouped.lockups.map((row) => row.name)).toEqual([
      "ZBCN_Lockup_005",
      "ZBCN_Lockup_003",
      "ZBCN Lockup",
      "ZBCN_Lockup_002",
      "ZBCN_Lockup_004",
    ]);
    expect(grouped.lockups.map((row) => row.vault?.address)).toEqual(STAKE_VAULT_ATAS.slice(0, 5));
    expect(grouped.rewardVaults.map((link) => link.address)).toEqual(REWARD_VAULT_ATAS);
    expect(JSON.stringify(grouped)).not.toMatch(/UAT/);
  });

  it("classifies vault labels before lockup labels", () => {
    expect(stakingAddressKind("ZBCN_Lockup_005 vault ATA")).toBe("stake-vault");
    expect(stakingAddressKind("Reward vault A (not staker principal)")).toBe("reward-vault");
    expect(stakingAddressKind("Staking program (Solscan)")).toBe("program");
    expect(stakingAddressKind("ZBCN Lockup")).toBe("lockup");
  });
});

describe("supplyRetailStakeModel", () => {
  it("states the live staked total as a subset of ZBCN retail, with principal and reward links split", () => {
    const zbcn = getProject("zebec-network");
    const lite = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/holders-lite.json"), "utf8"),
    );
    const staked = lite.views.combined.stakingStats.stakedTotal as number;
    expect(staked).toBeGreaterThan(0);

    const model = supplyRetailStakeModel(zbcn, staked, formatCompact);
    const shown = `${(staked / 1e9).toFixed(2)}B`;
    expect(model.note).toBe(`of which ${shown} is staked`);
    expect(model.body).toContain(shown);
    expect(model.body).toMatch(/inside Retail/);
    expect(model.body).toMatch(/not this principal/);
    expect(model.principalLinks.map((link) => link.address)).toEqual([PROGRAM, ...LOCKUPS.flatMap((lockup, i) => [lockup, STAKE_VAULT_ATAS[i]])]);
    expect(model.rewardLinks.map((link) => link.address)).toEqual(REWARD_VAULT_ATAS);
    expect(model.principalLinks.some((link) => link.kind === "reward-vault")).toBe(false);
  });
});
