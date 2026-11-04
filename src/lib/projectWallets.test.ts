import { describe, expect, it } from "vitest";
import { flowEdges, sellFrequency, windowForRange, type WindowSummary } from "./projectWallets";
import { TX_TYPES, txTypeInfo, txTypeTone } from "./txTypes";
import { RANGE_OPTIONS } from "./timeRange";

const summary = (o: Partial<WindowSummary> = {}): WindowSummary => ({
  from: "", to: "", devSold: { dex: 10, cex: 0, botDevShare: 5, total: 15 }, sellCount: 1, botSaleCount: 2, botSold: 14, sellDays: 2,
  internal: { count: 1, amount: 50 }, received: 0,
  payments: { stableOut: 0, stableOutCount: 0, stableIn: 0, stableInCount: 0, bySymbol: {}, topStableRecipients: [], topTokenDestinations: [] },
  byType: { transfer_out: { count: 1, amount: 3 } }, ...o,
});

describe("projectWallets helpers", () => {
  it("maps every page range to a ledger window, defaulting to 30d", () => {
    expect(windowForRange(undefined)).toBe("30d");
    expect(RANGE_OPTIONS.map((o) => windowForRange(o.days))).toEqual(["24h", "30d", "30d", "90d", windowForRange(RANGE_OPTIONS[4].days), "90d"]);
    expect(windowForRange(3)).toBe("72h");
  });
  it("flow edges: biggest first, zero dropped, internal kept but marked", () => {
    const e = flowEdges(summary(), "TEL");
    expect(e.map((x) => x.key)).toEqual(["internal", "dex", "bot", "transfer_out"]);
    expect(e[0].kind).toBe("internal");
  });
  it("sell frequency", () => {
    expect(sellFrequency(summary(), "30d")).toBe("2 of 30 days");
    expect(sellFrequency(summary({ sellCount: 0, botSaleCount: 0 }), "24h")).toBe("No selling");
  });
});

describe("txTypes catalog (shared with scripts/build-ledger.js)", () => {
  it("only the three selling types are headline, internal moves are internal", () => {
    expect(Object.entries(TX_TYPES).filter(([, t]) => t.headline).map(([k]) => k).sort()).toEqual(["bot_sell_dev_share", "cex_deposit", "dex_sell"]);
    expect(TX_TYPES.internal_shuffle.internal).toBe(true);
    expect(txTypeTone("dex_sell")).toBe("negative");
    expect(txTypeInfo("mystery").group).toBe("other");
  });
});
