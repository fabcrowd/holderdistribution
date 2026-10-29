import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { copyText, projectEntities } from "./projectCopy";
import { getProject } from "./projects";
import {
  CANONICAL_SUPPLY_BUCKETS,
  DEFAULT_ENTITY_BUCKET_LABELS,
  SUPPLY_GAP_LABEL,
  circulatingFormula,
  groupSupplyCategories,
  isOtherCategory,
  isStakingCategory,
} from "./supplyBreakdown";

const CANONICAL = new Set<string>(CANONICAL_SUPPLY_BUCKETS);

describe("groupSupplyCategories — fixed bucket set", () => {
  it("folds leftover reward vaults into Other and keeps staked principal inside Retail", () => {
    const zbcn = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/supply-reconciliation.json"), "utf8"),
    );
    const labels = projectEntities(getProject("zebec-network"));
    const buckets = groupSupplyCategories(zbcn.categories, zbcn.residual, labels);
    const other = buckets.find((b) => b.key === "other");
    const retail = buckets.find((b) => b.key === "retail");
    const treasury = buckets.find((b) => b.key === "treasury");
    expect(buckets.some((b) => b.key === "staking")).toBe(false);
    expect(other?.amount).toBeCloseTo(zbcn.categories.staking, 3);
    expect(other?.amount ?? 0).toBeLessThan(50_000_000);
    expect(retail?.amount ?? 0).toBeGreaterThan(35_000_000_000);
    expect(retail?.amount ?? 0).toBeGreaterThan(zbcn.categories.staking);
    expect(treasury?.label).toBe("Zebec Treasury & Buyback Vaults");
    expect(buckets.map((b) => b.key).every((key) => CANONICAL.has(key))).toBe(true);
    expect(buckets.every((b) => b.amount > 0)).toBe(true);
    expect(buckets.some((b) => b.key === "team" || b.key === "escrow")).toBe(false);
    const sum = buckets.reduce((s, b) => s + b.amount, 0);
    expect(Math.abs(sum - zbcn.totalSupply)).toBeLessThan(1);
  });

  it("orders the fixed set and hides empty slices", () => {
    const keys = groupSupplyCategories({
      retail: 1,
      dex: 1,
      cex: 1,
      staking: 1,
      treasury: 1,
      team: 1,
      holdings: 1,
      escrow: 1,
    }, 1).map((b) => b.key);
    expect(keys).toEqual([...CANONICAL_SUPPLY_BUCKETS]);
    expect(groupSupplyCategories({ retail: 1 }).map((b) => b.key)).toEqual(["retail"]);
  });

  it("keeps TEL staking-contract inside Treasury and does not invent a staking slice", () => {
    const tel = JSON.parse(readFileSync(resolve(process.cwd(), "public/data/supply-reconciliation.json"), "utf8"));
    const labels = projectEntities(getProject("tel"));
    const buckets = groupSupplyCategories(tel.categories, tel.residual, labels);
    expect(groupSupplyCategories({ retail: 5, "staking-contract": 3 }).map((b) => b.key)).toEqual([
      "retail",
      "treasury",
    ]);
    expect(groupSupplyCategories({ retail: 5, staking: 0 }).some((b) => b.key === "staking" || b.key === "other")).toBe(
      false,
    );
    expect(buckets.find((b) => b.key === "treasury")?.label).toBe("Telcoin Association-Controlled Safes");
    expect(buckets.find((b) => b.key === "holdings")?.label).toBe("Telcoin Holdings");
    expect(buckets.find((b) => b.key === "supplyGap")?.label).toBe(SUPPLY_GAP_LABEL);
    expect(buckets.some((b) => b.key === "team" || b.key === "staking")).toBe(false);
    expect(buckets.map((b) => b.key).every((key) => CANONICAL.has(key))).toBe(true);
    expect(isStakingCategory("staking")).toBe(true);
    expect(isStakingCategory("staking-contract")).toBe(false);
    expect(isOtherCategory("staking")).toBe(true);
  });
});

describe("circulating formula from present buckets", () => {
  it("names only the subtracted buckets, using each project's treasury label", () => {
    const tel = JSON.parse(readFileSync(resolve(process.cwd(), "public/data/supply-reconciliation.json"), "utf8"));
    const zbcn = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/supply-reconciliation.json"), "utf8"),
    );
    const telLabels = projectEntities(getProject("tel"));
    const zbcnLabels = projectEntities(getProject("zebec-network"));
    expect(circulatingFormula(tel.categories, telLabels, tel.circulatingExclusions.total)).toBe(
      "counted − Telcoin Association-Controlled Safes − committed escrow; remaining escrow included",
    );
    expect(circulatingFormula(zbcn.categories, zbcnLabels, zbcn.circulatingExclusions.total)).toBe(
      "counted − Zebec Treasury & Buyback Vaults",
    );
    expect(circulatingFormula({ retail: 10 }, DEFAULT_ENTITY_BUCKET_LABELS, 0)).toBe("counted");
    expect(circulatingFormula({ treasury: 2 }, { association: "Treasury" }, 0)).toBe("counted − Treasury");
  });
});

describe("groupSupplyCategories — supply gap label", () => {
  it("uses the canonical Supply gap name on the pie", () => {
    const r = groupSupplyCategories({ retail: 1 }, 2).find((b) => b.key === "supplyGap");
    expect(r?.label).toBe(SUPPLY_GAP_LABEL);
    const tel = getProject("tel");
    expect(copyText(tel, "supply.residual.bucketLabel", SUPPLY_GAP_LABEL)).toBe(SUPPLY_GAP_LABEL);
  });

  it("keeps ZBCN's drill-down copy about buybacks and burns", () => {
    const zbcn = getProject("zebec-network");
    const label = copyText(zbcn, "supply.residual.bucketLabel", SUPPLY_GAP_LABEL);
    expect(label).not.toMatch(/bridge/i);
    expect(label).toMatch(/burn/i);
    expect(groupSupplyCategories({ retail: 1 }, 2).find((b) => b.key === "supplyGap")?.label).toBe(SUPPLY_GAP_LABEL);
  });
});

describe("ZBCN staking copy", () => {
  const zbcn = getProject("zebec-network");
  it("holders.staked.info says staked is inside retail and keeps the Super App disclaimer", () => {
    const info = copyText(zbcn, "holders.staked.info", "generic");
    expect(info).toContain("AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp");
    expect(info).toMatch(/2\.42%/);
    expect(info).toMatch(/0\.5%/);
    expect(info).toMatch(/4\.75B/);
    expect(info).toMatch(/reward vaults/);
    expect(info).toMatch(/subset of Retail Held/);
    expect(info).toMatch(/credited to each staker/);
    expect(info).not.toMatch(/own bucket/);
    expect(info).not.toMatch(/not merged into the retail/);
    expect(info).not.toMatch(/not included in this Retail line/);
    expect(info).toMatch(/Global Staked/);
    expect(info).toMatch(/18\.9B/);
    expect(info).toMatch(/not current TVL/i);
    expect(info).toMatch(/methodology tip/i);
  });

  it("retail held copy credits staked ZBCN inside the retail figure", () => {
    const info = copyText(zbcn, "holders.retailHeld.info", "generic");
    expect(info).toMatch(/already inside this figure/);
    expect(info).toMatch(/credited to each staker/);
    expect(info).not.toMatch(/own bucket|not included in this Retail/);
    expect(copyText(zbcn, "supply.staking.bucketLabel", "Staking")).toBe("Reward vaults");
    expect(copyText(zbcn, "supply.staking.description", "")).toMatch(/included in Retail/);
    expect(copyText(zbcn, "supply.staking.description", "")).toMatch(/not staker principal/i);
    expect(copyText(zbcn, "supply.staking.description", "")).toMatch(/Global Staked/);
    expect(copyText(zbcn, "supply.retail.stakedNote", "")).toBe("of which {staked} is staked");
    expect(copyText(zbcn, "staking.intro", "")).toMatch(/credited into Retail on Supply/);
    expect(copyText(zbcn, "staking.intro", "")).toMatch(/not staker principal/i);
    expect(copyText(zbcn, "staking.intro", "")).toMatch(/Global Staked/);
    expect(copyText(zbcn, "staking.addresses.note", "")).toMatch(/not staker principal/i);
    const text = JSON.stringify(zbcn.copy?.text ?? {});
    expect(text).not.toMatch(/Staking vaults/i);
    const supply = readFileSync(resolve(process.cwd(), "src/components/SupplyBreakdown.tsx"), "utf8");
    expect(supply).toContain('data-testid="supply-retail-staked"');
    expect(supply).toContain("Open Staking Overview");
    expect(supply).toContain("<StakingAddressList");
    expect(supply).not.toMatch(/case "staking"/);
  });

  it("residual body does not claim Ethereum / Polygon / Base bridges", () => {
    const body = copyText(zbcn, "supply.residual.body", "");
    expect(body).not.toMatch(/Ethereum|Polygon|Base\b/);
    expect(body).toMatch(/buybacks and burns/);
  });

  it("copy figures match the live staking + supply snapshots (within rounding)", () => {
    const staking = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/solana-staking.json"), "utf8"),
    );
    const supply = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/supply-reconciliation.json"), "utf8"),
    );
    const lockup = staking.lockups.find(
      (l: { address: string }) => l.address === "AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp",
    );
    expect(lockup.vaultReconcile).toBe("exempt");
    expect(lockup.vaultGapRatio).toBeCloseTo(0.0242, 3);
    // Positions drift with the daily refresh; copy says "~4.75B", so allow ±0.05B.
    expect(staking.stakedTotal / 1e9).toBeCloseTo(4.75, 1);
    // Stake-vault principal is credited to stakers. The staking category is
    // only the reward-vault remainder, not a ~4.76B sibling of retail.
    const stakeItems = (supply.items as Array<{ category: string; name: string | null }>).filter(
      (item) => item.category === "staking",
    );
    expect(stakeItems.length).toBeGreaterThan(0);
    expect(stakeItems.every((item) => /reward/i.test(item.name ?? ""))).toBe(true);
    expect(supply.categories.staking).toBeLessThan(staking.stakedTotal * 0.01);
    expect(supply.categories.retail).toBeGreaterThan(staking.stakedTotal);
  });
});
