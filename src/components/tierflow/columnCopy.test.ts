import { describe, expect, it } from "vitest";
import { netChangeTip, periodPhrase, walletColumns } from "./columnCopy";

describe("periodPhrase", () => {
  it("names the real crossings window", () => {
    expect(periodPhrase({ from: "2026-01-01", to: "2026-10-30" })).toBe("from 2026-01-01 to 2026-10-30");
    expect(periodPhrase({ from: "a", to: "b" }, (s) => s.toUpperCase())).toBe("from A to B");
  });
  it("falls back to the selected period, never a snapshot baseline", () => {
    expect(periodPhrase(null)).toBe("over the selected period");
    expect(periodPhrase(undefined)).not.toContain("since");
  });
});

describe("walletColumns", () => {
  const cols = walletColumns("from Jan 1 to Oct 30");
  it("names the window in the joined and left tips", () => {
    expect(cols.joined.tip).toContain("from Jan 1 to Oct 30");
    expect(cols.left.tip).toContain("from Jan 1 to Oct 30");
    expect(cols.joined.tip).not.toContain("since");
  });
  it("keeps the labels short", () => {
    expect([cols.joined.label, cols.wallets.label, cols.left.label]).toEqual(["Joined", "Wallets", "Left"]);
  });
  it("wallets tip describes the bar inside each tile", () => {
    expect(cols.wallets.tip).toContain("The bar inside each tile grows with the number of wallets (log scale).");
  });
  it("net tips state the in-minus-out arithmetic and the baseline", () => {
    expect(netChangeTip("over the selected period")).toBe("Net = joined - left over the selected period.");
    expect(netChangeTip("from A to B", "tel", "ZBCN")).toBe("Net = ZBCN in - ZBCN out from A to B.");
  });
});
