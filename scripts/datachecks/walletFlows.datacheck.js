// Data checks (npm run check:data): TEL's committed wallet-flows report is valid (moved unchanged from
// scripts/lib/walletFlows.test.js) and is what the forensics gate bundles.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateWalletFlowsReport } from "../lib/walletFlows.js";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

describe.runIf(inScope("tel"))("committed wallet-flows report", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const report = JSON.parse(fs.readFileSync(path.join(root, "data/forensics/wallet-flows.json"), "utf8"));

  it("is valid", () => {
    expect(validateWalletFlowsReport(report)).toEqual([]);
  });
});

// The forensics-gate tests (netlify/functions-src/forensics-gate*.test.ts) now serve a trimmed fixture. These are
// their assertions on the real bundled report's content ("returns the report with the right password",
// "TEL keeps its bundled report next to demo"), run on the real file through the same loader.
describe.runIf(inScope("tel"))("bundled wallet-flows report served by the forensics gate", () => {
  it("is the real report with the content the gate tests check", async () => {
    const { __resetWalletFlowsCache, loadWalletFlows } = await import("../../netlify/functions-src/walletFlowsSource.ts");
    __resetWalletFlowsCache();
    const { report, source } = await loadWalletFlows({}, fetch, 0, "tel");
    expect(source).toBe("bundled");
    expect(report.version).toBe(1);
    expect(report.knownWallets.length).toBeGreaterThan(10);
    expect(report.distribution.classes.length).toBeGreaterThan(5);
    expect(Array.isArray(report.largeSellers)).toBe(true);
  });
});
