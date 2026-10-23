import { describe, expect, it } from "vitest";
import type { WalletFlowsKnownWallet } from "./walletFlowsTypes";
import { filterWallets, nextSort, shortAddress, sortWallets, verdictTone } from "./walletFlowsTable";

const w = (label: string, balance: number, s90: number, extra: Partial<WalletFlowsKnownWallet> = {}): WalletFlowsKnownWallet => ({
  label,
  group: "Test group",
  entityClass: "telcoin",
  source: "test",
  confidence: "high",
  address: `0x${label.toLowerCase().padEnd(40, "0")}`,
  chains: ["ethereum"],
  balance,
  balanceDetail: {},
  balanceUsd: 0,
  outflows: { "72h": {}, "30d": {}, "90d": {} },
  sellVenue: { "72h": 0, "30d": s90 / 2, "90d": s90 },
  sellVenueUsd90d: 0,
  sampleTxs: [],
  verdict: s90 > 0 ? "selling / sending to sell venues" : "inactive",
  ...extra,
});

const rows = [w("Alpha", 10, 0), w("Bravo", 300, 50), w("Charlie", 20, 900, { group: "Holdings" })];

describe("wallet flows table", () => {
  it("filters by label, group, address and verdict, case-insensitively", () => {
    expect(filterWallets(rows, { query: "brav" }).map((r) => r.label)).toEqual(["Bravo"]);
    expect(filterWallets(rows, { query: "HOLDINGS" }).map((r) => r.label)).toEqual(["Charlie"]);
    expect(filterWallets(rows, { query: rows[0].address.slice(0, 8) }).map((r) => r.label)).toContain("Alpha");
    expect(filterWallets(rows, { query: "selling" }).map((r) => r.label)).toEqual(["Bravo", "Charlie"]);
  });
  it("can hide wallets that never reached a sell venue", () => {
    expect(filterWallets(rows, { onlySelling: true }).map((r) => r.label)).toEqual(["Bravo", "Charlie"]);
  });
  it("sorts by numeric columns and label", () => {
    expect(sortWallets(rows, "90d", "desc").map((r) => r.label)).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(sortWallets(rows, "balance", "asc").map((r) => r.label)).toEqual(["Alpha", "Charlie", "Bravo"]);
    expect(sortWallets(rows, "label", "desc").map((r) => r.label)).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(rows.map((r) => r.label)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
  it("toggles direction on the active column and defaults new columns sensibly", () => {
    expect(nextSort({ key: "90d", dir: "desc" }, "90d")).toEqual({ key: "90d", dir: "asc" });
    expect(nextSort({ key: "90d", dir: "desc" }, "label")).toEqual({ key: "label", dir: "asc" });
    expect(nextSort({ key: "label", dir: "asc" }, "balance")).toEqual({ key: "balance", dir: "desc" });
  });
  it("formats addresses and verdicts", () => {
    expect(shortAddress("0x17fcc1f3aaaaaaaaaaaaaaaaaaaaaaaaaaaa4143")).toBe("0x17fc…4143");
    expect(verdictTone("selling / sending")).toBe("selling");
    expect(verdictTone("inactive")).toBe("inactive");
    expect(verdictTone("internal moves only")).toBe("neutral");
  });
});
