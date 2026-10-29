import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { coingeckoComparison } from "./coingeckoComparison";

const TEL_CG = 95_077_236_367;

describe("coingeckoComparison", () => {
  it("hides the row when the feed has no positive CoinGecko figure", () => {
    expect(coingeckoComparison(86e9, null)).toBeNull();
    expect(coingeckoComparison(86e9, undefined)).toBeNull();
    expect(coingeckoComparison(86e9, 0)).toBeNull();
    expect(coingeckoComparison(86e9, Number.NaN)).toBeNull();
    expect(coingeckoComparison(null, 99e9)).toBeNull();
  });

  it("compares our circulating supply with the figure the feed actually published", () => {
    expect(coingeckoComparison(86_871_493_766, 99_998_768_619)).toEqual({
      reported: 99_998_768_619,
      delta: 86_871_493_766 - 99_998_768_619,
    });
  });

  it("does not substitute TEL's traced snapshot for a missing figure", () => {
    expect(coingeckoComparison(86e9, null)).not.toEqual(expect.objectContaining({ reported: TEL_CG }));
  });
});

describe("CoinGecko circulating feeds", () => {
  const read = (file: string) => JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));

  it("ZBCN publishes its own CoinGecko circulating supply, never TEL's 95.08B", () => {
    const zbcn = read("public/data/zebec-network/supply-reconciliation.json");
    expect(zbcn.coingeckoCirculating).not.toBe(TEL_CG);
    expect(zbcn.coingeckoCirculating).toBeGreaterThan(0);
    expect(zbcn.coingeckoCirculating).toBeGreaterThan(99e9);
  });

  it("TEL still publishes its traced CoinGecko snapshot", () => {
    const tel = read("public/data/supply-reconciliation.json");
    expect(tel.coingeckoCirculating).toBe(TEL_CG);
  });
});

describe("SupplyBreakdown has no hardcoded CoinGecko circulating constant", () => {
  it("does not embed TEL's 95.08B figure", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/SupplyBreakdown.tsx"), "utf8");
    expect(src).not.toMatch(/95_077_236_367|95077236367|95\.08/);
    expect(src).toContain("coingeckoComparison");
  });
});
