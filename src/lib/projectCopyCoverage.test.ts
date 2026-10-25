import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copyText, projectEntities } from "./projectCopy";
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
  "src/lib/methodology.ts",
  "src/lib/supplyBreakdown.ts",
  "src/lib/staking.ts",
  "src/components/MethodologyInfo.tsx",
  "src/components/Footer.tsx",
  "src/components/TreasuryHistoryChart.tsx",
  "src/components/SupplyBreakdown.tsx",
  "src/components/terminal/SupplyTerminal.tsx",
  "src/components/terminal/TerminalDashboard.tsx",
  "src/components/terminal/DistributionTerminal.tsx",
  "src/components/terminal/HoldersTerminal.tsx",
  "src/components/HeadlineBody.tsx",
  "src/components/LockedAnalysisTile.tsx",
];

/** Named TEL entities / custodians: TEL-only facts that belong in tel.json copy. */
const TEL_ENTITY_RE = /Telcoin|Anchorage|BitGo|KuCoin/;

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("project-driven copy coverage", () => {
  it.each(PROJECT_AGNOSTIC_FILES)("%s has no hardcoded TEL ticker in code", (file) => {
    const code = stripComments(readFileSync(resolve(process.cwd(), file), "utf8"));
    const hits = code.split("\n").filter((l) => /\bTEL\b/.test(l) || TEL_ENTITY_RE.test(l));
    expect(hits).toEqual([]);
  });

  it("no project-agnostic file keeps a TEL-named number formatter", () => {
    for (const file of PROJECT_AGNOSTIC_FILES) {
      const code = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(code, file).not.toMatch(/format(Compact|Full|Signed)TEL/);
    }
  });

  it("TEL keeps its entity names; other projects get the shared slots filled generically", () => {
    expect(projectEntities(getProject("tel"))).toEqual({
      association: "Telcoin Association-Controlled Safes",
      associationShort: "Association",
      holdings: "Telcoin Holdings",
      holdingsShort: "Holdings",
    });
    const abc: ProjectConfig = { slug: "abc", name: "Abacus", ticker: "ABC", chains: [] };
    expect(projectEntities(abc)).toEqual({
      association: "Abacus Foundation-Controlled Safes",
      associationShort: "Foundation",
      holdings: "Abacus Team Wallets",
      holdingsShort: "Team",
    });
  });

  it("TEL keeps its Supply-view entity and footer copy through overrides", () => {
    const tel = getProject("tel");
    expect(copyText(tel, "footer.affiliation", "generic")).toBe("Telcoin Holdings, the Telcoin Association, or any of their subsidiaries");
    expect(copyText(tel, "treasury.history.info", "generic")).toMatch(/Telcoin Holdings is a SEPARATE entity/);
    expect(copyText(tel, "treasury.history.info", "generic")).toMatch(/BitGo, Anchorage/);
    expect(copyText(tel, "treasury.series.council", "generic")).toBe("Association — TAO & Safes");
    expect(copyText(tel, "supply.coingecko.note", "generic")).toMatch(/Anchorage.*\{treasuryNow\} is invisible/);
    expect(copyText(tel, "supply.escrow.description", "generic")).toBe("TEL held by third-party custodians under a SAFE");
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
      // {amount} / {treasuryNow} are runtime values the widget substitutes itself.
      const unknown = (tpl.match(/\{[a-zA-Z]+\}/g) ?? []).filter(
        (p) => !["{ticker}", "{name}", "{chains}", "{supply}", "{amount}", "{treasuryNow}"].includes(p),
      );
      expect(unknown, id).toEqual([]);
      expect(copyText(tel, id, "")).not.toMatch(/\{(ticker|name|chains|supply)\}/);
    }
  });
});
