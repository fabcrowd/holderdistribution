import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins which holders-lite / feed field each count surface reads, so a label
 * and its field cannot drift apart (see src/lib/holderCounts.ts):
 *   - Landing card "Unique wallets": overlap.uniqueCount
 *   - KPI tile / stat card "Retail Wallets": views.<view>.metrics.holderCount
 *     (per-chain sum, comparable with the holders-history series), whose
 *     tooltip also states the unique figure
 *   - holders-summary.json retailHolderCount (balance >= retail threshold) and
 *     velocity.currentCount are not displayed anywhere
 */
const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("holder-count surfaces", () => {
  it("landing card reads retail wallets (metrics.holderCount) and uses the shared label", () => {
    expect(code("src/lib/landingStats.ts")).toMatch(/num\(m\?\.holderCount\)/);
    expect(code("src/components/TokenCard.tsx")).toContain("label={RETAIL_WALLETS_LABEL}");
  });

  it("headline tile and stat card read metrics.holderCount, labelled Retail Wallets with the per-chain tooltip", () => {
    const tiles = code("src/hooks/useEcosystemHeadlineTiles.ts");
    expect(tiles).toMatch(/view\.metrics\.holderCount/);
    expect(tiles).toContain("label: RETAIL_WALLETS_LABEL");
    expect(tiles).toContain("retailWalletsInfo(");
    const widget = code("src/components/WalletHoldingsWidget.tsx");
    expect(widget).toMatch(/formatInteger\(result\.metrics\.holderCount\)/);
    expect(widget).toContain("label: RETAIL_WALLETS_LABEL");
    expect(widget).toContain("retailWalletsInfo(");
  });

  it("the overlap card is the only 'Unique Wallets' tile and reads uniqueCount", () => {
    const widget = code("src/components/WalletHoldingsWidget.tsx");
    expect(widget).toMatch(/>Unique Wallets<[\s\S]{0,200}stats\.uniqueCount/);
  });

  it("no surface displays the threshold-based retailHolderCount or velocity.currentCount", () => {
    const files = [
      "src/lib/landingStats.ts",
      "src/components/TokenCard.tsx",
      "src/hooks/useEcosystemHeadlineTiles.ts",
      "src/components/WalletHoldingsWidget.tsx",
      "src/components/terminal/HoldersTerminal.tsx",
      "src/lib/holderSummary.ts",
    ];
    for (const f of files) {
      const text = code(f);
      expect(text, f).not.toMatch(/retailHolderCount/);
      expect(text, f).not.toMatch(/velocity\??\.currentCount/);
    }
  });

  it("states holder wording once: no 'Retail Holders' label remains on the count surfaces", () => {
    for (const f of ["src/hooks/useEcosystemHeadlineTiles.ts", "src/components/WalletHoldingsWidget.tsx", "src/lib/holderSummary.ts"]) {
      expect(code(f), f).not.toMatch(/["'`]Retail [Hh]olders?\b/);
    }
  });
});
