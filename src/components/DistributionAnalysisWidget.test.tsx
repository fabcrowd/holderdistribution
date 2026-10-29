import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DistributionAnalysisWidget from "./DistributionAnalysisWidget";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

const env = vi.hoisted(() => ({ phone: false }));

vi.mock("@/hooks/useMediaQuery", () => ({
  PHONE_QUERY: "(max-width: 639px)",
  useMediaQuery: () => env.phone,
}));
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: { ticker: "ZBCN", chains: [{ key: "ethereum", label: "Ethereum" }] } }),
}));
vi.mock("@/hooks/useProjectCopy", () => ({
  useProjectCopy: () => ({ ticker: "ZBCN", tiers: [] }),
}));
vi.mock("@/hooks/useHolderHistoricalDelta", () => ({ useHolderHistoricalDelta: () => ({ data: undefined }) }));
vi.mock("@/hooks/useClassificationChangelog", () => ({
  useClassificationChangelog: () => ({ data: undefined }),
  getEventsAffecting: () => [],
}));
vi.mock("@/components/TierFlowDiagram", () => ({ TierFlowDiagram: () => <div data-testid="tier-flow" /> }));
vi.mock("@/components/DexSwaps", () => ({ DexSwaps: () => <div data-testid="dex-swaps" /> }));
vi.mock("@/components/MethodologyInfo", () => ({ MethodologyInfo: () => null }));
vi.mock("@/lib/holderTiers", () => ({ bucketFloor: () => 1 }));

const distribution = [
  { label: "1-10", count: 5, totalBalance: 10, percent: 40 },
  { label: "10+", count: 2, totalBalance: 20, percent: 60 },
];
const snapshot = {
  views: { combined: { distribution }, ethereum: { distribution } },
} as unknown as HolderLiteSnapshot;

const render = (selectedView: "combined" | "ethereum", rangeDays: number) =>
  renderToStaticMarkup(
    <DistributionAnalysisWidget snapshot={snapshot} selectedView={selectedView} rangeDays={rangeDays} />,
  );

const STACKED_CHART = "% of retail by balance range";

describe("DistributionAnalysisWidget layout", () => {
  beforeEach(() => {
    env.phone = false;
  });

  it("phone, All chains: uses the same stacked chart and table as the Ethereum view", () => {
    env.phone = true;
    const allChains = render("combined", 7);
    const ethereum = render("ethereum", 7);
    expect(allChains).toContain(STACKED_CHART);
    expect(ethereum).toContain(STACKED_CHART);
    expect(allChains).toContain("<table");
    expect(ethereum).toContain("<table");
  });

  it("phone, All chains: keeps the tier-flow diagram below the table", () => {
    env.phone = true;
    const html = render("combined", 7);
    expect(html).toContain('data-testid="tier-flow"');
    expect(html.indexOf("<table")).toBeLessThan(html.indexOf('data-testid="tier-flow"'));
    expect(html).not.toContain('data-testid="dex-swaps"');
  });

  it("phone, Ethereum: no tier-flow diagram and no DEX fallback", () => {
    env.phone = true;
    const html = render("ethereum", 7);
    expect(html).not.toContain('data-testid="tier-flow"');
    expect(html).not.toContain('data-testid="dex-swaps"');
  });

  it("desktop, All chains: the tier-flow diagram replaces the stacked chart", () => {
    const html = render("combined", 7);
    expect(html).toContain('data-testid="tier-flow"');
    expect(html).not.toContain(STACKED_CHART);
  });

  it("phone, All chains with no range: stacked chart plus DEX fallback, no diagram", () => {
    env.phone = true;
    const html = render("combined", 0);
    expect(html).toContain(STACKED_CHART);
    expect(html).toContain('data-testid="dex-swaps"');
    expect(html).not.toContain('data-testid="tier-flow"');
  });
});
