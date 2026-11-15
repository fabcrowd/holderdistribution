import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DistributionTerminal } from "./DistributionTerminal";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

const proj = vi.hoisted(() => ({ holders: undefined as unknown }));
vi.mock("@/hooks/useProject", () => ({ useProject: () => ({ project: { ticker: "ZBCN", holders: proj.holders } }) }));
vi.mock("@/hooks/useProjectCopy", () => ({ useProjectCopy: () => ({ t: (s: string) => s.replace(/\{ticker\}/g, "ZBCN") }) }));
const baseline = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/useHolderHistoricalDelta", () => ({ useHolderHistoricalDelta: () => ({ data: baseline.data }) }));
vi.mock("@/hooks/useClassificationChangelog", () => ({
  useClassificationChangelog: () => ({ data: undefined }),
  getEventsAffecting: () => [],
}));
vi.mock("@/components/tierflow/useTierGeometry", () => ({ useTierGeometry: () => ({ tiers: ["1-10", "10+"] }) }));
vi.mock("@/hooks/useMotion", () => ({ useIntro: () => false, useChartIntro: () => false }));
const flow = vi.hoisted(() => ({ ready: true, fields: [] as unknown[], avail: { hasTransitions: true, hasOutflows: true } }));
vi.mock("@/components/tierflow/useFlowField", () => ({ useFlowField: () => ({ fields: flow.fields, ready: flow.ready, avail: flow.avail }) }));
vi.mock("@/components/InfoTip", () => ({
  InfoTip: ({ content, label }: { content: unknown; label: string }) => <span data-info={label}>{typeof content === "string" ? content : null}</span>,
}));
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

const noCause = { inTotal: 0, total: 0 };
flow.fields = [
  { label: "1-10", index: 0, addedCount: 20, removedCount: 25, cause: noCause },
  { label: "10+", index: 1, addedCount: 4, removedCount: 1, cause: noCause },
];

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <DistributionTerminal snapshot={snapshot} snapshotError={false} selectedView="combined" rangeDays={7} />
    </QueryClientProvider>,
  );

describe("DistributionTerminal dust note", () => {
  const DUST = "sub-1-ZBCN dust wallets are counted in the lowest tier.";
  it("keeps the exact sentence for tiers whose floor is 1", () => {
    proj.holders = undefined;
    const html = render();
    expect(html).toContain(`Retail only; ${DUST}`);
  });
  it("omits the sentence when the lowest tier starts at 0", () => {
    proj.holders = {
      distributionTiers: [
        { label: "1+", min: 1, max: null },
        { label: "<1", min: 0, max: 1 },
      ],
      balanceRanges: [{ label: "<1", min: 0, max: 1 }, { label: "1+", min: 1, max: null }],
    };
    const html = render();
    expect(html).not.toContain("dust wallets");
    expect(html).toContain("Retail only.");
    proj.holders = undefined;
  });
});

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
  it("panel header shows only the range: a total net across tiers is always 0, so none is printed", () => {
    const html = render();
    expect(html).toContain("7D");
    expect(html).not.toContain("tiers gained");
    expect(html).not.toContain("net over");
    expect(html).not.toContain("†");
  });
  it("omits the Details accordion until the flows are ready", () => {
    flow.ready = false;
    const bare = { views: { combined: { distribution: [{ label: "1-10", count: 5, totalBalance: 10, percent: 100 }] } } } as unknown as HolderLiteSnapshot;
    baseline.data = undefined;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DistributionTerminal snapshot={bare} snapshotError={false} selectedView="combined" rangeDays={7} />
      </QueryClientProvider>,
    );
    expect(html).not.toContain('data-testid="distribution-details"');
    flow.ready = true;
    baseline.data = { distribution: [{ label: "1-10", count: 3, totalBalance: 8 }, { label: "10+", count: 2, totalBalance: 20 }] };
  });
  it("renders a dash, not NaN or 0, for a tier whose count and percent are unknown", () => {
    const holes = { views: { combined: { distribution: [{ label: "1-10", totalBalance: 10 }] } } } as unknown as HolderLiteSnapshot;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DistributionTerminal snapshot={holes} snapshotError={false} selectedView="combined" rangeDays={7} />
      </QueryClientProvider>,
    );
    expect(html).not.toContain("NaN");
    const row = html.slice(html.indexOf('data-tier="1-10"'));
    expect(row.slice(0, row.indexOf("</tr>"))).toContain("—");
    expect(row.slice(0, row.indexOf("</tr>"))).not.toContain("%</td>");
  });
  it("gives the Tiers table the full row when nothing is selected", () => {
    expect(render()).toContain("grid-cols-1");
  });
  it("omits the Details accordion when the wallet-crossings feed is missing (no zero-length bars)", () => {
    flow.avail = { hasTransitions: false, hasOutflows: true };
    const html = render();
    flow.avail = { hasTransitions: true, hasOutflows: true };
    expect(html).not.toContain('data-testid="distribution-details"');
  });
});
