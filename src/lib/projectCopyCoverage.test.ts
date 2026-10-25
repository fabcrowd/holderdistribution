import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copyText } from "./projectCopy";
import { getProject, type ProjectConfig } from "./projects";

/**
 * Guard for the project-agnostic terminals: these files render copy that must
 * come from the active project (useProjectCopy / config), so a bare "TEL" in
 * their code (comments excluded) is a regression. TEL-only facts belong in
 * config/projects/tel.json `copy`, not in the component.
 */
const PROJECT_AGNOSTIC_FILES = [
  "src/pages/NotFound.tsx",
  "src/components/terminal/MiniCharts.tsx",
  "src/components/CexHistoryTiles.tsx",
  "src/components/ExchangeNetflow.tsx",
  "src/components/ExchangeFlowWidget.tsx",
  "src/components/DexSwaps.tsx",
  "src/components/HolderGrowthWidget.tsx",
  "src/components/DistributionAnalysisWidget.tsx",
  "src/components/WalletHoldingsWidget.tsx",
  "src/components/SupplyBreakdown.tsx",
  "src/components/TierFlowDiagram.tsx",
  "src/components/GlossaryDialog.tsx",
  "src/hooks/useEcosystemHeadlineTiles.ts",
  "src/lib/holderSummary.ts",
  "src/lib/glossary.ts",
];

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("project-driven copy coverage", () => {
  it.each(PROJECT_AGNOSTIC_FILES)("%s has no hardcoded TEL ticker in code", (file) => {
    const code = stripComments(readFileSync(resolve(process.cwd(), file), "utf8"));
    const hits = code.split("\n").filter((l) => /\bTEL\b/.test(l));
    expect(hits).toEqual([]);
  });

  it("TEL keeps its specific wording through copy.text overrides", () => {
    const tel = getProject("tel");
    expect(copyText(tel, "holders.cex.info", "generic {ticker}")).toContain("KuCoin");
    expect(copyText(tel, "staking.intro", "generic")).toMatch(/^TEL staked by retail in the legacy staking contract and the v3 StakingModule/);
    expect(copyText(tel, "not-overridden", "Staked {ticker} on {chains}")).toBe("Staked TEL on Ethereum, Polygon and Base");
  });

  it("other projects get the generic template, filled", () => {
    const abc: ProjectConfig = {
      slug: "abc",
      name: "Abacus",
      ticker: "ABC",
      chains: [{ key: "ethereum", name: "Ethereum", chainId: 1, explorer: "", tokens: [{ generation: "v1", address: "0x", decimals: 18 }] }],
    };
    const s = copyText(abc, "holders.cex.info", "{ticker} sitting in known exchange wallets on {chains}.");
    expect(s).toBe("ABC sitting in known exchange wallets on Ethereum.");
  });

  it("every TEL copy.text override only uses known placeholders", () => {
    const tel = getProject("tel");
    for (const [id, tpl] of Object.entries(tel.copy?.text ?? {})) {
      const unknown = (tpl.match(/\{[a-z]+\}/g) ?? []).filter((p) => !["{ticker}", "{name}", "{chains}", "{supply}"].includes(p));
      expect(unknown, id).toEqual([]);
      expect(copyText(tel, id, "")).not.toMatch(/\{(ticker|name|chains|supply)\}/);
    }
  });
});
