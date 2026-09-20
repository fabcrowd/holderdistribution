import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeChainMetrics, RETAIL_THRESHOLD } from "./holderMetrics.js";

describe("resync retail.count contract", () => {
  it("never equates retail.count to the full kept-holder length", () => {
    // Locks the bug that shipped in resync-chain-holders.js:
    //   chain.metrics.retail.count = kept.length
    const kept = [
      { address: "0x1", balance: RETAIL_THRESHOLD },
      { address: "0x2", balance: RETAIL_THRESHOLD - 1 },
      { address: "0x3", balance: 10_000 },
    ];
    const metrics = computeChainMetrics(kept);
    expect(metrics.holderCount).toBe(3);
    expect(metrics.retail.count).toBe(2);
    expect(metrics.retail.count).not.toBe(kept.length);
  });

  it("resync script source uses computeChainMetrics, not kept.length for retail", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/resync-chain-holders.js"),
      "utf8",
    );
    expect(src).toContain("computeChainMetrics");
    expect(src).toContain("buildSummary");
    expect(src).toContain("EMERGENCY ONLY");
    // Strip comments so the doc sentence "never set retail.count = kept.length"
    // does not trip the assignment guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/retail\.count\s*=\s*kept\.length/);
  });
});
