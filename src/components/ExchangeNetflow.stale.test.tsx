import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ytdDays } from "@/lib/timeRange";
import { ExchangeNetflow } from "./ExchangeNetflow";

// Feed ends 2025-10-27 and never gets newer; "today" is fixed 13 months later.
const FEED = [
  { date: "2025-10-25", in: 1_000_000, out: 400_000, net: 600_000 },
  { date: "2025-10-26", in: 2_000_000_000, out: 1_800_000_000, net: 200_000_000 },
  { date: "2025-10-27", in: 190_000_000, out: 0, net: 190_000_000 },
];

let rows = FEED;
vi.mock("@/hooks/useExchangeFlow", () => ({
  useExchangeFlow: () => ({ data: rows, isPending: false, isError: false }),
}));
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: { ticker: "ONDO", name: "Ondo", chains: [{ key: "ethereum", name: "Ethereum", tokens: [] }] } }),
}));
vi.mock("@/hooks/useProjectCopy", () => ({
  useProjectCopy: () => ({ ticker: "ONDO", t: (s: string) => s }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  rows = FEED;
});
afterEach(() => vi.useRealTimers());

describe("ExchangeNetflow with a stale feed", () => {
  it("does not sum the whole stale feed under YTD; says the feed's last date instead", () => {
    const html = renderToStaticMarkup(<ExchangeNetflow rangeDays={ytdDays()} />);
    expect(html).toContain('data-testid="exchange-flow-empty"');
    expect(html).toContain("No exchange-flow data in this range. Feed has data through Oct 27, 2025.");
    expect(html).not.toContain("Deposits (in)");
  });

  it("shows a Data through caveat when rows do fall in the range but the feed is old", () => {
    const html = renderToStaticMarkup(<ExchangeNetflow rangeDays={500} />);
    expect(html).toContain("Deposits (in)");
    expect(html).toContain('data-testid="exchange-flow-stale"');
    expect(html).toContain("Data through Oct 27, 2025");
  });

  it("has no caveat for a fresh feed", () => {
    rows = [{ date: "2026-11-04", in: 5, out: 3, net: 2 }];
    const html = renderToStaticMarkup(<ExchangeNetflow rangeDays={30} />);
    expect(html).toContain("Deposits (in)");
    expect(html).not.toContain("exchange-flow-stale");
  });
});
