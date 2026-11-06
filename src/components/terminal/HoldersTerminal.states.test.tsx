import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { __resetActiveSlug } from "@/lib/projectStore";
import { ytdDays } from "@/lib/timeRange";
import { HoldersTerminal } from "./HoldersTerminal";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

const state = vi.hoisted(() => ({
  growth: { series: [] as unknown[], balanceSeries: [] as unknown[], stakingSeries: [] as unknown[] },
  flow: [] as unknown[],
}));

vi.mock("@/hooks/useHolderGrowth", () => ({
  useHolderGrowth: () => ({ data: state.growth, isLoading: false, error: null }),
}));
vi.mock("@/hooks/useExchangeFlow", () => ({
  useExchangeFlow: () => ({ data: state.flow, isLoading: false, isError: false }),
}));
vi.mock("@/hooks/useCexBalanceHistory", () => ({
  useCexBalanceHistory: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/hooks/useClassificationChangelog", () => ({
  useClassificationChangelog: () => ({ data: undefined }),
  getEventsAffecting: () => [],
}));
vi.mock("@/hooks/useMotion", () => ({ useIntro: () => false, useChartIntro: () => false }));

const snapshot = {
  views: {
    combined: {
      balanceStats: { gini: Number.NaN, distributionBuckets: [], average: 0, median: 0 },
      concentration: { top: { "10": 500 } },
    },
  },
} as unknown as HolderLiteSnapshot;

const render = (rangeDays: number) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <HoldersTerminal snapshot={snapshot} snapshotError={false} selectedView="combined" rangeDays={rangeDays} onExplore={() => {}} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  __resetActiveSlug("ondo");
  state.growth = { series: [], balanceSeries: [], stakingSeries: [] };
  state.flow = [{ date: "2025-10-27", in: 2_190_000_000, out: 1_800_000_000, net: 390_000_000 }];
});
afterEach(() => {
  vi.useRealTimers();
  __resetActiveSlug("tel");
});

describe("HoldersTerminal exchange net flow", () => {
  it("does not total a 13-month-old feed under YTD", () => {
    const html = render(ytdDays());
    expect(html).toContain("No exchange-flow data in this range. Feed has data through Oct 27, 2025.");
    expect(html).not.toContain("2.19B");
  });

  it("totals the feed and notes its last date when the range reaches it", () => {
    const html = render(500);
    expect(html).toContain("in 2.19B");
    expect(html).toContain("Data through Oct 27, 2025");
  });
});

describe("HoldersTerminal growth chart empty states", () => {
  it("says no history recorded yet for an empty series, never the generic copy", () => {
    const html = render(30);
    expect(html).toContain("No history recorded yet.");
    expect(html).not.toContain("No data for this period.");
  });

  it("says history is still building for a single snapshot, with the start date when it begins inside the range", () => {
    state.growth = {
      series: [{ timestamp: "2026-11-04T00:00:00Z", holders: 10 }],
      balanceSeries: [{ timestamp: "2026-11-04T00:00:00Z", retail: 1, cex: 1 }],
      stakingSeries: [],
    };
    const html = render(90);
    expect(html).toContain("History is still building: 1 snapshot in this range. History tracked from Nov 4, 2026.");
  });
});

describe("HoldersTerminal null guards", () => {
  it("shows a dash for a non-finite Gini and an unknown retail total instead of 0%", () => {
    const html = render(30);
    expect(html).not.toContain("NaN");
    expect(html).toMatch(/Gini <span[^>]*>—<\/span>/);
    expect(html).not.toContain("0.0%");
  });
});
