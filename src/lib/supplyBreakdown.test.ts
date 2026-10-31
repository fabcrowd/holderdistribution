import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { copyText, projectEntities } from "./projectCopy";
import { getProject } from "./projects";
import {
  CANONICAL_SUPPLY_BUCKETS,
  DEFAULT_DEVELOPER_HOLDINGS,
  DEFAULT_SLICE_OPACITY,
  DEVELOPER_BUCKET_LABEL,
  DIMMED_SLICE_OPACITY,
  OTHER_CATEGORY_KEYS,
  RESIDUAL_SLICE_OPACITY,
  SUPPLY_GAP_LABEL,
  circulatingFormula,
  developerGroups,
  groupSupplyCategories,
  isDeveloperCategory,
  isOtherCategory,
  resolveDeveloperHoldings,
} from "./supplyBreakdown";

const CANONICAL = new Set<string>(CANONICAL_SUPPLY_BUCKETS);
const readJson = (p: string) => JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8"));
const telDeveloper = () => resolveDeveloperHoldings(getProject("tel").supply?.developerHoldings);
const zbcnDeveloper = () => resolveDeveloperHoldings(getProject("zebec-network").supply?.developerHoldings);

describe("groupSupplyCategories — fixed bucket set", () => {
  it("is Retail, DEX, CEX, Developer holdings, Other, Supply gap", () => {
    expect([...CANONICAL_SUPPLY_BUCKETS]).toEqual(["retail", "dex", "cex", "developer", "other", "supplyGap"]);
  });

  it("orders the fixed set and hides empty slices", () => {
    const keys = groupSupplyCategories(
      { retail: 1, dex: 1, cex: 1, staking: 1, burn: 1, treasury: 1, team: 1, holdings: 1, escrow: 1 },
      1,
    ).map((b) => b.key);
    expect(keys).toEqual([...CANONICAL_SUPPLY_BUCKETS]);
    expect(groupSupplyCategories({ retail: 1 }).map((b) => b.key)).toEqual(["retail"]);
    expect(groupSupplyCategories({ retail: 5, staking: 0 }).map((b) => b.key)).toEqual(["retail"]);
  });

  it("folds every developer-held category into one bucket with sub-categories in config order", () => {
    const buckets = groupSupplyCategories(
      { retail: 50, treasury: 10, council: 4, holdings: 3, escrow: 20, staking: 6, "whale-unattributed": 7 },
      0,
      telDeveloper(),
    );
    const dev = buckets.find((b) => b.key === "developer");
    expect(dev?.label).toBe(DEVELOPER_BUCKET_LABEL);
    expect(dev?.amount).toBe(43);
    expect(dev?.subcategories?.map((g) => [g.category, g.amount])).toEqual([
      ["treasury", 10],
      ["council", 4],
      ["holdings", 3],
      ["staking", 6],
      ["escrow", 20],
    ]);
    expect(buckets.map((b) => b.key)).toEqual(["retail", "developer", "other"]);
    expect(buckets.reduce((s, b) => s + b.amount, 0)).toBe(100);
  });

  it("uses each project's own sub-category labels, so TEL and ZBCN differ", () => {
    const tel = developerGroups({ holdings: 1, staking: 1 }, telDeveloper());
    const zbcn = developerGroups({ holdings: 1, staking: 1 }, zbcnDeveloper());
    expect(tel.map((g) => g.label)).toEqual(["Telcoin Holdings", "Team / reward contracts"]);
    expect(zbcn.map((g) => g.label)).toEqual(["Team & allocation wallets", "Reward vaults"]);
  });

  it("falls back to the generic default when a project declares nothing", () => {
    expect(resolveDeveloperHoldings(undefined)).toBe(DEFAULT_DEVELOPER_HOLDINGS);
    expect(resolveDeveloperHoldings({ subcategories: [] })).toBe(DEFAULT_DEVELOPER_HOLDINGS);
  });

  it("never lists a category in two buckets, in the default or in any project config", () => {
    for (const cfg of [DEFAULT_DEVELOPER_HOLDINGS, telDeveloper(), zbcnDeveloper()]) {
      const cats = cfg.subcategories.map((s) => s.category);
      expect(new Set(cats).size).toBe(cats.length);
      for (const c of cats) {
        expect(isOtherCategory(c), c).toBe(false);
        expect(["retail", "dex", "cex", "bridge-lock"]).not.toContain(c);
      }
    }
    expect(OTHER_CATEGORY_KEYS.some((k) => isDeveloperCategory(DEFAULT_DEVELOPER_HOLDINGS, k))).toBe(false);
  });

  it("partitions the real ZBCN feed: treasury, team and reward vaults sit inside Developer holdings", () => {
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

  it("partitions the real TEL feed: escrow and Holdings sit inside Developer holdings", () => {
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

  it("config labels all three TELx reward contracts as staking so they land in Developer holdings", () => {
    const exclusions = readJson("config/exclusions.json");
    for (const a of [
      "0x79e5a6ffe2e6ba053a80e1b199c4f328938f40ca",
      "0x7feb8febddb66189417f732b4221a52e23b926c4",
      "0x8f702676830ddca2801a4a7cdb971cde4df697ae",
    ]) {
      expect(exclusions.labels[a].category, a).toBe("staking");
      expect(exclusions.labels[a].name).toMatch(/reward contract/);
    }
    expect(isDeveloperCategory(telDeveloper(), "staking")).toBe(true);
  });

  it("keeps staked principal inside Retail: no staked slice, supply sums unchanged", () => {
    const buckets = groupSupplyCategories({ retail: 50, cex: 20, treasury: 10, staking: 5 }, 15);
    expect(buckets.map((b) => b.key)).toEqual(["retail", "cex", "developer", "supplyGap"]);
    expect(buckets.find((b) => b.key === "retail")?.amount).toBe(50);
    expect(buckets.reduce((s, b) => s + b.amount, 0)).toBe(100);
  });
});

describe("circulating formula is unchanged by the grouping", () => {
  it("names only the subtracted pieces, using each project's treasury label", () => {
    const tel = readJson("public/data/supply-reconciliation.json");
    const zbcn = readJson("public/data/zebec-network/supply-reconciliation.json");
    const telLabels = projectEntities(getProject("tel"));
    const zbcnLabels = projectEntities(getProject("zebec-network"));
    expect(circulatingFormula(tel.categories, telLabels, tel.circulatingExclusions.total)).toBe(
      "counted − Telcoin Association-Controlled Safes − committed escrow; remaining escrow included",
    );
    expect(circulatingFormula(zbcn.categories, zbcnLabels, zbcn.circulatingExclusions.total)).toBe(
      "counted − Zebec Treasury & Buyback Vaults",
    );
    expect(circulatingFormula({ retail: 10 })).toBe("counted");
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
    expect(info).toMatch(/never decrease when a position is claimed/);
    expect(info).toMatch(/14\.2B/);
    expect(info).not.toMatch(/appears to sum/);
    expect(info).toMatch(/methodology tip/i);
  });

  it("retail held copy credits staked ZBCN inside the retail figure", () => {
    const info = copyText(zbcn, "holders.retailHeld.info", "generic");
    expect(info).toMatch(/already inside this figure/);
    expect(info).toMatch(/credited to each staker/);
    expect(info).not.toMatch(/own bucket|not included in this Retail/);
    expect(zbcn.copy?.text?.["supply.staking.bucketLabel"]).toBeUndefined();
    expect(copyText(zbcn, "supply.staking.description", "")).toMatch(/developer-controlled/);
    expect(copyText(zbcn, "supply.staking.description", "")).toMatch(/counted in Team/);
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
    // Cumulative lockup counters never decrease on claim: Global Staked (~18.9B) = unclaimed + claimed.
    const lockupTotals = (staking.lockups as Array<{ totalStakedRaw: string; activeRaw: string }>).reduce(
      (acc, l) => ({
        total: acc.total + Number(l.totalStakedRaw) / 1e6,
        active: acc.active + Number(l.activeRaw) / 1e6,
      }),
      { total: 0, active: 0 },
    );
    expect(lockupTotals.total / 1e9).toBeCloseTo(18.9, 1);
    expect(lockupTotals.active / 1e9).toBeCloseTo(staking.stakedTotal / 1e9, 2);
    // Copy says ~14.2B already claimed; the snapshot drifts daily, so allow +-0.1B.
    expect(Math.abs((lockupTotals.total - lockupTotals.active) / 1e9 - 14.2)).toBeLessThan(0.1);
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

type HslTriple = [number, number, number];
type Rgb = [number, number, number];

const MIN_DONUT_CONTRAST = 3;
const SUPPLY_TOKEN_CALL = /^hsl\(var\(--([\w-]+)\)\)$/;

const tokenTriple = (block: string, name: string): HslTriple => {
  const match = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(block);
  if (!match) throw new Error(`token --${name} not found in theme block`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const hslToRgb = ([h, s, l]: HslTriple): Rgb => {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
};

const linearChannel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);

const contrastRatio = (a: Rgb, b: Rgb): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Opacity composite of a fill over an opaque background, per sRGB channel. */
const compositeOver = (fg: Rgb, alpha: number, bg: Rgb): Rgb => [
  fg[0] * alpha + bg[0] * (1 - alpha),
  fg[1] * alpha + bg[1] * (1 - alpha),
  fg[2] * alpha + bg[2] * (1 - alpha),
];

describe("Supply donut palette — >= 3:1 against --card in both themes", () => {
  const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
  const darkStart = css.indexOf(".dark {");
  const lightBlock = css.slice(css.indexOf("--card:"), darkStart);
  const darkBlock = css.slice(darkStart, css.indexOf("}", darkStart));
  const themes: Array<[string, string]> = [
    ["light", lightBlock],
    ["dark", darkBlock],
  ];
  // Residual is the supply-gap bucket (alignment "residual"); the component
  // rests it at RESIDUAL_SLICE_OPACITY, retail-aligned buckets at 1, others at DEFAULT.
  const restingOpacity = (alignment: string): number =>
    alignment === "retail" ? 1 : alignment === "residual" ? RESIDUAL_SLICE_OPACITY : DEFAULT_SLICE_OPACITY;
  const sampleBuckets = groupSupplyCategories(
    { retail: 1, dex: 1, cex: 1, staking: 1, burn: 1, treasury: 1, team: 1, holdings: 1, escrow: 1 },
    1,
  );

  for (const [theme, block] of themes) {
    describe(`${theme} theme`, () => {
      const card = hslToRgb(tokenTriple(block, "card"));
      const bucketRgb = (color: string): Rgb => {
        const match = SUPPLY_TOKEN_CALL.exec(color);
        if (!match) throw new Error(`slice colour must be hsl(var(--token)), got ${color}`);
        return hslToRgb(tokenTriple(block, match[1]));
      };

      const failuresAt = (opacityOf: (alignment: string) => number): string[] =>
        sampleBuckets.flatMap((b) => {
          const ratio = contrastRatio(
            compositeOver(bucketRgb(b.color), opacityOf(b.alignment), card),
            card,
          );
          return ratio >= MIN_DONUT_CONTRAST ? [] : [`${b.key}: ${ratio.toFixed(2)}:1`];
        });

      it("gives every bucket its own colour", () => {
        const triples = sampleBuckets.map((b) => bucketRgb(b.color).map((c) => c.toFixed(6)).join(","));
        expect(new Set(triples).size).toBe(sampleBuckets.length);
      });

      it("meets 3:1 vs --card at full opacity", () => {
        expect(failuresAt(() => 1)).toEqual([]);
      });

      it("meets 3:1 vs --card at each bucket's resting opacity", () => {
        expect(failuresAt(restingOpacity)).toEqual([]);
      });

      it("meets 3:1 vs --card at DIMMED_SLICE_OPACITY", () => {
        expect(failuresAt(() => DIMMED_SLICE_OPACITY)).toEqual([]);
      });
    });
  }
});
