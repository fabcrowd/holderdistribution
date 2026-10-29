import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DistributionTerminal } from "./DistributionTerminal";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

vi.mock("@/hooks/useProject", () => ({ useProject: () => ({ project: { ticker: "ZBCN" } }) }));
vi.mock("@/hooks/useProjectCopy", () => ({ useProjectCopy: () => ({ t: (s: string) => s.replace(/\{ticker\}/g, "ZBCN") }) }));
const baseline = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/useHolderHistoricalDelta", () => ({ useHolderHistoricalDelta: () => ({ data: baseline.data }) }));
vi.mock("@/hooks/useClassificationChangelog", () => ({
  useClassificationChangelog: () => ({ data: undefined }),
  getEventsAffecting: () => [],
}));
vi.mock("@/components/tierflow/useTierGeometry", () => ({ useTierGeometry: () => ({ tiers: ["1-10", "10+"] }) }));
vi.mock("@/hooks/useMotion", () => ({ useIntro: () => false, useChartIntro: () => false }));
vi.mock("@/components/TierFlowDiagram", () => ({ TierFlowDiagram: () => <div data-testid="tier-flow" /> }));

const snapshot = {
  views: {
    combined: {
      distribution: [
        { label: "1-10", count: 5, previousCount: 3, totalBalance: 10, percent: 40 },
        { label: "10+", count: 2, totalBalance: 20, percent: 60 },
      ],
    },
  },
} as unknown as HolderLiteSnapshot;

baseline.data = { distribution: [{ label: "1-10", count: 3, totalBalance: 8 }, { label: "10+", count: 2, totalBalance: 20 }] };

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <DistributionTerminal snapshot={snapshot} snapshotError={false} selectedView="combined" rangeDays={7} />
    </QueryClientProvider>,
  );

describe("DistributionTerminal", () => {
  it("keeps the net-change chart behind a collapsed Details accordion", () => {
    const html = render();
    expect(html).toContain('data-testid="distribution-details"');
    expect(html).toContain("Details: net wallet change by tier");
    expect(html).not.toContain('data-testid="panel-net-change"');
  });
  it("drops the always-visible explainer paragraph and uses the project ticker", () => {
    const html = render();
    expect(html).not.toContain('data-testid="tier-flows-explainer"');
    expect(html).not.toContain("TEL");
    expect(html).toContain("ZBCN");
  });
  it("omits the Details accordion when no tier has a baseline", () => {
    const bare = { views: { combined: { distribution: [{ label: "1-10", count: 5, totalBalance: 10, percent: 100 }] } } } as unknown as HolderLiteSnapshot;
    baseline.data = undefined;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DistributionTerminal snapshot={bare} snapshotError={false} selectedView="combined" rangeDays={7} />
      </QueryClientProvider>,
    );
    expect(html).not.toContain('data-testid="distribution-details"');
    baseline.data = { distribution: [{ label: "1-10", count: 3, totalBalance: 8 }, { label: "10+", count: 2, totalBalance: 20 }] };
  });
  it("gives the Tiers table the full row when nothing is selected", () => {
    expect(render()).toContain("grid-cols-1");
  });
});
