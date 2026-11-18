// Data checks (npm run check:data): moved unchanged from src/lib/supplyBreakdown.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProject } from "@/lib/projects";
import { CANONICAL_SUPPLY_BUCKETS, SUPPLY_GAP_LABEL, groupSupplyCategories, resolveDeveloperHoldings } from "@/lib/supplyBreakdown";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs: string[]) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

const CANONICAL = new Set<string>(CANONICAL_SUPPLY_BUCKETS);
const readJson = (p: string) => JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8"));
const telDeveloper = () => resolveDeveloperHoldings(getProject("tel").supply?.developerHoldings);
const zbcnDeveloper = () => resolveDeveloperHoldings(getProject("zebec-network").supply?.developerHoldings);

describe("groupSupplyCategories — fixed bucket set", () => {
  it.runIf(inScope("zebec-network"))("partitions the real ZBCN feed: treasury, team and reward vaults sit inside Developer holdings", () => {
    const zbcn = readJson("public/data/zebec-network/supply-reconciliation.json");
    const buckets = groupSupplyCategories(zbcn.categories, zbcn.residual, zbcnDeveloper());
    const dev = buckets.find((b) => b.key === "developer");
    expect(dev?.amount).toBeCloseTo(
      zbcn.categories.treasury + (zbcn.categories.holdings ?? 0) + (zbcn.categories.team ?? 0) + zbcn.categories.staking,
      3,
    );
    expect(buckets.map((b) => b.key).every((key) => CANONICAL.has(key))).toBe(true);
    expect(buckets.every((b) => b.amount > 0)).toBe(true);
    expect(Math.abs(buckets.reduce((s, b) => s + b.amount, 0) - zbcn.totalSupply)).toBeLessThan(1);
  });

  it.runIf(inScope("tel"))("partitions the real TEL feed: escrow and Holdings sit inside Developer holdings", () => {
    const tel = readJson("public/data/supply-reconciliation.json");
    const buckets = groupSupplyCategories(tel.categories, tel.residual, telDeveloper());
    const dev = buckets.find((b) => b.key === "developer");
    const expected = ["treasury", "council", "holdings", "team", "staking", "escrow", "staking-contract"].reduce(
      (s, k) => s + (tel.categories[k] ?? 0),
      0,
    );
    expect(dev?.amount).toBeCloseTo(expected, 3);
    expect(buckets.map((b) => b.key).every((key) => CANONICAL.has(key))).toBe(true);
    expect(buckets.find((b) => b.key === "supplyGap")?.label).toBe(SUPPLY_GAP_LABEL);
    expect(Math.abs(buckets.reduce((s, b) => s + b.amount, 0) - tel.totalSupply)).toBeLessThan(1);
  });
});

describe("ZBCN staking copy", () => {
  it.runIf(inScope("zebec-network"))("copy figures match the live staking + supply snapshots (within rounding)", () => {
    const staking = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/solana-staking.json"), "utf8"),
    );
    const supply = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/data/zebec-network/supply-reconciliation.json"), "utf8"),
    );
    // Exempt lockups carry a finite gap ratio; the values themselves drift with the daily refresh.
    const exempt = (staking.lockups as Array<{ vaultReconcile: string; vaultGapRatio: number }>).filter(
      (l) => l.vaultReconcile === "exempt",
    );
    expect(exempt.length).toBeGreaterThan(0);
    expect(exempt.every((l) => Number.isFinite(l.vaultGapRatio) && l.vaultGapRatio >= 0)).toBe(true);
    expect(staking.stakedTotal).toBeGreaterThan(0);
    // Cumulative lockup counters never decrease on claim: Global Staked = unclaimed + claimed.
    const lockupTotals = (staking.lockups as Array<{ totalStakedRaw: string; activeRaw: string }>).reduce(
      (acc, l) => ({
        total: acc.total + Number(l.totalStakedRaw) / 1e6,
        active: acc.active + Number(l.activeRaw) / 1e6,
      }),
      { total: 0, active: 0 },
    );
    expect(lockupTotals.active / 1e9).toBeCloseTo(staking.stakedTotal / 1e9, 2);
    // Claimed = cumulative minus active, so it can never be negative.
    expect(lockupTotals.total).toBeGreaterThanOrEqual(lockupTotals.active);
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
