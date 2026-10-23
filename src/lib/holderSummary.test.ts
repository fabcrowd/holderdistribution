import { describe, expect, it } from "vitest";
import { buildHolderSummary } from "./holderSummary";

const base = {
  holders: { current: 95_932, previous: 97_417 },
  retailHeld: { current: 70_350_000_000, previous: 70_000_000_000 },
  staked: { current: 4_170_000_000, previous: 3_974_820_000 },
  cex: { current: 21_570_000_000, previous: 21_570_000_000 },
  totalSupply: 100_000_000_000,
  rangeLabel: "YTD",
};

describe("buildHolderSummary", () => {
  it("answers the 5-second question in one sentence", () => {
    const s = buildHolderSummary(base)!;
    expect(s.headline).toBe("95,932 retail wallets hold 70.35B TEL — 70% of the 100B supply.");
  });

  it("describes direction and size of each change", () => {
    const s = buildHolderSummary(base)!;
    expect(s.points.map((p) => [p.id, p.trend])).toEqual([
      ["holders", "down"],
      ["staked", "up"],
      ["cex", "flat"],
    ]);
    expect(s.points[0].text).toBe("Retail holders down 1,485 (−1.5%) this year");
    expect(s.points[1].text).toBe("Staked TEL up 195.18M this year, now 4.17B");
    expect(s.points[2].text).toBe("21.57B TEL (22%) sits on exchanges");
  });

  it("never reports a trend across a reclassification", () => {
    const s = buildHolderSummary({ ...base, rangeLabel: "30D", holders: { ...base.holders, comparisonBlocked: true } })!;
    expect(s.points[0]).toEqual({
      id: "holders",
      text: "Holder change over 30D not directly comparable (some wallets were reclassified)",
      trend: "unknown",
    });
  });

  it("returns null until the snapshot has loaded", () => {
    expect(buildHolderSummary({ ...base, holders: { current: null, previous: null } })).toBeNull();
  });
});
