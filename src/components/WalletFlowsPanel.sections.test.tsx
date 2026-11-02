import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesJournal, UnlabelledTrace } from "./WalletFlowsPanel";
import type { WalletFlowsReport, WalletFlowsSale, WalletFlowsTraceDestination } from "@/lib/walletFlowsTypes";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const sale = (overrides: Partial<WalletFlowsSale> = {}): WalletFlowsSale => ({
  wallet: WALLET,
  label: "Desk wallet",
  sig: "sig-1",
  url: "https://solscan.io/tx/sig-1",
  t: "2026-10-20T12:00:00Z",
  zbcnSold: 1500,
  proceeds: [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL", raw: "1", decimals: 9, amount: 2.5, usd: 300, source: "native" }],
  proceedsUsd: 300,
  effectivePriceUsd: 0.2,
  onwardStatus: "partial",
  onward: [],
  ...overrides,
});

const destination = (overrides: Partial<WalletFlowsTraceDestination> = {}): WalletFlowsTraceDestination => ({
  wallet: WALLET,
  label: "Desk wallet",
  dest: DEST,
  received: 5000,
  t: "2026-10-21T08:00:00Z",
  status: "open",
  onward: [],
  byKind: { cex: 1200 },
  unaccounted: 3800,
  ...overrides,
});

const report = (extra: Partial<WalletFlowsReport>): WalletFlowsReport =>
  ({
    version: 1,
    generated: "2026-11-01T00:00:00Z",
    priceUsd: 0.2,
    priceSource: "test",
    chains: ["solana"],
    notes: [],
    ...extra,
  }) as WalletFlowsReport;

describe("SalesJournal", () => {
  it("lists each sale with proceeds, price and onward status", () => {
    const html = renderToStaticMarkup(
      <SalesJournal
        report={report({
          salesJournal: {
            window: "90d",
            valuedAtReportTime: true,
            totals: { count: 1, zbcnSold: 1500, proceedsUsd: 300 },
            sales: [sale()],
          },
        })}
      />,
    );
    expect(html).toContain('aria-labelledby="wf-sales"');
    expect(html).toMatch(/Sales of \S+ for other tokens \(last 90 days\)/);
    expect(html).toContain("Proceeds in SOL are valued at report time.");
    expect(html).toContain("1 sales · 1.5K");
    expect(html).toContain("Tracing");
    expect(html).toContain("$0.2");
    expect(html).toContain("https://solscan.io/tx/sig-1");
    expect(html).toContain("tx <svg");
  });

  it("omits the valuation note when proceeds were not valued at report time", () => {
    const html = renderToStaticMarkup(
      <SalesJournal
        report={report({
          salesJournal: {
            window: "90d",
            valuedAtReportTime: false,
            totals: { count: 1, zbcnSold: 1500, proceedsUsd: null },
            sales: [sale({ proceedsUsd: null, effectivePriceUsd: null, proceeds: [{ ...sale().proceeds[0], usd: null }] })],
          },
        })}
      />,
    );
    expect(html).not.toContain("valued at report time");
    expect(html).toContain("unpriced");
  });
});

describe("UnlabelledTrace", () => {
  it("shows each destination with its onward split and status", () => {
    const html = renderToStaticMarkup(
      <UnlabelledTrace
        report={report({
          unlabelledTrace: {
            window: "90d",
            totals: { received: 5000, byKind: { cex: 1200 } },
            destinations: [destination()],
          },
        })}
      />,
    );
    expect(html).toContain('aria-labelledby="wf-trace"');
    expect(html).toContain("Sent to unlabelled wallets (last 90 days)");
    expect(html).toContain("5.0K TEL in total");
    expect(html).toContain("cex 1.2K");
    expect(html).toContain("Tracing");
  });

  it("shows none seen when no onward hop was traced", () => {
    const html = renderToStaticMarkup(
      <UnlabelledTrace
        report={report({
          unlabelledTrace: {
            window: "90d",
            totals: { received: 5000, byKind: {} },
            destinations: [destination({ byKind: {}, status: "busy" })],
          },
        })}
      />,
    );
    expect(html).toContain("none seen");
    expect(html).toContain("Busy address: label it");
  });
});
