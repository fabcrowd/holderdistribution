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
  it("adds a Staking bucket for non-zero categories.staking (ZBCN pie sums to supply)", () => {
    const zbcn = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/supply-reconciliation.json"), "utf8"),
    );
    const buckets = groupSupplyCategories(zbcn.categories, zbcn.residual);
    const staking = buckets.find((b) => b.key === "staking");
    expect(staking?.amount).toBeCloseTo(zbcn.categories.staking, 3);
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
  it("holders.staked.info carries the vault-gap explainer and the dual-totals note", () => {
    const info = copyText(zbcn, "holders.staked.info", "generic");
    expect(info).toContain("AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp");
    expect(info).toMatch(/2\.42%/);
    expect(info).toMatch(/0\.5%/);
    expect(info).toMatch(/4\.795B/);
    expect(info).toMatch(/4\.808B/);
    expect(info).toMatch(/reward vaults/);
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
    expect(staking.stakedTotal / 1e9).toBeCloseTo(4.795, 2);
    expect(supply.categories.staking / 1e9).toBeCloseTo(4.808, 2);
  });
});
