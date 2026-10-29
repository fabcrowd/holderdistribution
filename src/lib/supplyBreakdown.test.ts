import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { copyText } from "./projectCopy";
import { getProject } from "./projects";
import {
  DEFAULT_ENTITY_BUCKET_LABELS,
  DEFAULT_RESIDUAL_BUCKET_LABEL,
  groupSupplyCategories,
  isStakingCategory,
} from "./supplyBreakdown";

describe("groupSupplyCategories — staking bucket", () => {
  it("keeps a staking slice only for leftover program custody, and the pie still sums", () => {
    const zbcn = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/supply-reconciliation.json"), "utf8"),
    );
    const buckets = groupSupplyCategories(zbcn.categories, zbcn.residual, {
      ...DEFAULT_ENTITY_BUCKET_LABELS,
      staking: "Reward vaults",
    });
    const staking = buckets.find((b) => b.key === "staking");
    const retail = buckets.find((b) => b.key === "retail");
    expect(staking?.amount).toBeCloseTo(zbcn.categories.staking, 3);
    expect(staking?.label).toBe("Reward vaults");
    // Staked principal is inside retail, not this slice.
    expect(staking?.amount ?? 0).toBeLessThan(50_000_000);
    expect(retail?.amount ?? 0).toBeGreaterThan(35_000_000_000);
    const sum = buckets.reduce((s, b) => s + b.amount, 0);
    expect(Math.abs(sum - zbcn.totalSupply)).toBeLessThan(1);
  });

  it("orders Staking after CEX and before the association bucket", () => {
    const keys = groupSupplyCategories({ retail: 1, cex: 1, staking: 1, treasury: 1 }).map((b) => b.key);
    expect(keys.indexOf("staking")).toBeGreaterThan(keys.indexOf("cex"));
    expect(keys.indexOf("staking")).toBeLessThan(keys.indexOf("association"));
  });

  it("keeps TEL safe: missing / zero staking → no bucket; staking-contract stays in Association", () => {
    expect(groupSupplyCategories({ retail: 5, "staking-contract": 3 }).map((b) => b.key)).toEqual([
      "retail",
      "association",
    ]);
    expect(groupSupplyCategories({ retail: 5, staking: 0 }).some((b) => b.key === "staking")).toBe(false);
    expect(isStakingCategory("staking")).toBe(true);
    expect(isStakingCategory("staking-contract")).toBe(false);
  });
});

describe("groupSupplyCategories — residual label", () => {
  it("defaults to the bridge wording (TEL)", () => {
    const r = groupSupplyCategories({ retail: 1 }, 2).find((b) => b.key === "residual");
    expect(r?.label).toBe(DEFAULT_RESIDUAL_BUCKET_LABEL);
    const tel = getProject("tel");
    expect(copyText(tel, "supply.residual.bucketLabel", DEFAULT_RESIDUAL_BUCKET_LABEL)).toBe("In transit (bridges)");
  });

  it("uses the project label (ZBCN: buybacks/burns, not bridges)", () => {
    const zbcn = getProject("zebec-network");
    const label = copyText(zbcn, "supply.residual.bucketLabel", DEFAULT_RESIDUAL_BUCKET_LABEL);
    const r = groupSupplyCategories({ retail: 1 }, 2, { ...DEFAULT_ENTITY_BUCKET_LABELS, residual: label }).find(
      (b) => b.key === "residual",
    );
    expect(r?.label).toBe(label);
    expect(label).not.toMatch(/bridge/i);
    expect(label).toMatch(/burn/i);
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
