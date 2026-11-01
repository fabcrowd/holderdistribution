import { describe, expect, it } from "vitest";
import { validateWalletFlowsReport } from "./walletFlows.js";
import { applyAsOfNulls, asOfPrice } from "./walletFlowsAsOf.js";

const ASOF = { ts: 1788220800, iso: "2026-09-01T00:00:00.000Z" };
const ADDR = "0x" + "ab".repeat(20);

function sampleReport() {
  return {
    version: 1,
    generated: "2026-10-31T12:00:00.000Z",
    generator: "scripts/generate-wallet-flows.js",
    priceUsd: 0.02,
    priceSource: "CoinGecko simple/price (telcoin)",
    chains: ["ethereum"],
    windows: {},
    notes: ["existing note"],
    distribution: { totalSupply: 100e9, counted: 100e9, classes: [{ key: "retail", label: "Retail", tel: 1 }] },
    telcoinTotals: { "72h": { total: 10, usd: 0.2, byVenue: { CEX: 10 } }, "30d": { total: 0, usd: 0, byVenue: {} } },
    knownWallets: [
      {
        label: "Treasury",
        address: ADDR,
        balance: 500,
        balanceDetail: { ethereum_legacy: 500 },
        balanceUsd: 10,
        outflows: { "72h": { CEX: 10 } },
        sellVenue: { "72h": 10, "30d": 0, "90d": 0 },
        sellVenueUsd90d: 0,
      },
    ],
    fundingLinks: [],
    botCluster: { addresses: [ADDR], balance: 900, dexSales: { "72h": 5 }, cexDeposits: { "72h": 0 } },
    largeSellers: [{ rank: 1, entity: "x", tel: 9e6, netTel: 9e6, usd: 180000 }],
  };
}

describe("asOfPrice", () => {
  it("returns an explicit null price with a note naming the date", () => {
    expect(asOfPrice(ASOF.iso)).toEqual({
      priceUsd: null,
      priceSource: expect.stringContaining("2026-09-01T00:00:00.000Z"),
    });
    expect(asOfPrice(ASOF.iso).priceSource).toMatch(/no historical price/);
  });
});

describe("applyAsOfNulls", () => {
  it("sets balances and USD values to null, keeping the flow counts", () => {
    const out = applyAsOfNulls(sampleReport(), ASOF);
    const [w] = out.knownWallets;
    expect(w.balance).toBeNull();
    expect(w.balanceDetail).toBeNull();
    expect(w.balanceUsd).toBeNull();
    expect(w.sellVenueUsd90d).toBeNull();
    expect(w.outflows).toEqual({ "72h": { CEX: 10 } });
    expect(out.telcoinTotals["72h"]).toEqual({ total: 10, usd: null, byVenue: { CEX: 10 } });
    expect(out.botCluster.balance).toBeNull();
    expect(out.botCluster.dexSales).toEqual({ "72h": 5 });
    expect(out.largeSellers[0]).toMatchObject({ tel: 9e6, usd: null });
    expect(out.priceUsd).toBeNull();
  });

  it("records the as-of date and a note that balances and prices are not historical", () => {
    const out = applyAsOfNulls(sampleReport(), ASOF);
    expect(out.asOf).toBe(ASOF.iso);
    expect(out.notes[0]).toBe("existing note");
    const joined = out.notes.join("\n");
    expect(joined).toMatch(/as-of 2026-09-01T00:00:00.000Z: balances and USD values are null/);
    expect(joined).toMatch(/current supply reconciliation/);
  });

  it("returns a report that still passes validateWalletFlowsReport", () => {
    expect(validateWalletFlowsReport(applyAsOfNulls(sampleReport(), ASOF))).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = sampleReport();
    applyAsOfNulls(input, ASOF);
    expect(input.knownWallets[0].balance).toBe(500);
    expect(input.notes).toEqual(["existing note"]);
    expect(input.asOf).toBeUndefined();
  });
});
