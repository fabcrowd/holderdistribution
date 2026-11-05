import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLedgerReport } from "../../../scripts/lib/ledger/aggregate.js";
import txTypes from "../../../config/ledger-tx-types.json";
import type { LedgerReport } from "@/lib/projectWallets";

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ slug: "tel", project: { chains: [{ key: "polygon", explorer: "https://polygonscan.com" }] } }),
}));

const { LedgerBody, FlowMap } = await import("./ProjectWalletsView");

const NOW = 1_790_000_000;
const DEV = "0x" + "11".repeat(20);
const ev = (type: string, amount: number, ago: number, extra: Record<string, unknown> = {}) => {
  const info = (txTypes.types as Record<string, { headline?: boolean; internal?: boolean }>)[type];
  const time = NOW - ago;
  return {
    chain: "polygon", hash: `0x${type}${ago}`, time, date: new Date(time * 1000).toISOString().slice(0, 10), type, direction: "out",
    wallet: DEV, walletLabel: "Treasury", counterparty: "0x" + "22".repeat(20), counterpartyLabel: "QuickSwap", asset: "token", symbol: "TEL",
    amount, reason: "test", internal: !!info.internal, headline: !!info.headline, ...extra,
  };
};
const report = buildLedgerReport({
  cfg: { slug: "tel", windows: ["24h", "72h", "30d", "90d"], historyDays: 90, developerWallets: [{ address: DEV, label: "Treasury", chains: ["polygon"] }], botCluster: null },
  events: [ev("dex_sell", 1_000_000, 3600), ev("internal_shuffle", 5_000_000, 7200), ev("cex_deposit", 2_000_000, 10 * 86400)],
  nowSec: NOW,
  txTypes,
  project: { name: "Telcoin", ticker: "TEL" },
}) as LedgerReport;

describe("ProjectWalletsView", () => {
  it("renders the 30d default with headline, flow map and linked transactions", () => {
    const html = renderToStaticMarkup(<LedgerBody report={report} initialWindow="30d" />);
    const text = new JSDOM(html).window.document.body.textContent ?? "";
    expect(text).toContain("Developer wallets sold 3.0M TEL in the last 30d");
    expect(html).toContain('data-testid="pw-flow-map"');
    expect(html).toContain("https://polygonscan.com/tx/0xdex_sell3600");
    expect(html).toMatch(/internal shuffles?/);
    expect(html).toMatch(/aria-checked="true"[^>]*>30d</);
  });

  it("24h shows only that day and never counts internal shuffles", () => {
    const html = renderToStaticMarkup(<LedgerBody report={report} initialWindow="24h" />);
    expect(html).toContain("sold 1.0M TEL in the last 24h");
    expect(html).not.toContain("0xcex_deposit");
  });

  it("flow map orders by amount and drops empty edges", () => {
    const html = renderToStaticMarkup(<FlowMap edges={[]} ticker="TEL" />);
    expect(html).toContain("No outflows");
  });
});
