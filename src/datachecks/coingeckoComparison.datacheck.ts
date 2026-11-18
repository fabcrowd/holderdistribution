// Data checks (npm run check:data): moved unchanged from src/lib/coingeckoComparison.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs: string[]) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

const TEL_CG = 95_077_236_367;

describe("CoinGecko circulating feeds", () => {
  const read = (file: string) => JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));

  it.runIf(inScope("zebec-network"))("ZBCN publishes its own CoinGecko circulating supply, never TEL's 95.08B", () => {
    const zbcn = read("public/data/zebec-network/supply-reconciliation.json");
    expect(zbcn.coingeckoCirculating).not.toBe(TEL_CG);
    expect(zbcn.coingeckoCirculating).toBeGreaterThan(0);
    expect(zbcn.coingeckoCirculating).toBeGreaterThan(99e9);
  });

  it.runIf(inScope("tel"))("TEL still publishes its traced CoinGecko snapshot", () => {
    const tel = read("public/data/supply-reconciliation.json");
    expect(tel.coingeckoCirculating).toBe(TEL_CG);
  });
});
