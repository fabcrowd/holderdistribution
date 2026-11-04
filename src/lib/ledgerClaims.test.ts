import { describe, expect, it } from "vitest";
import { claimText, matchFilter, plural, summaryClaims, type ClaimSeg } from "@/lib/ledgerClaims";
import type { LedgerEvent, LedgerReport, WindowSummary } from "@/lib/projectWallets";

const NOW = Date.parse("2026-11-01T00:00:00Z") / 1000;
const ev = (o: Partial<LedgerEvent>): LedgerEvent => ({ chain: "polygon", hash: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0"), time: NOW - 3600, date: "2026-10-31", type: "dex_sell", direction: "out", wallet: "0xdev", walletLabel: "Dev", counterparty: "0xdex", counterpartyLabel: "DEX", asset: "token", symbol: "TEL", amount: 10, reason: "r", ...o });
const SAFE = "0x00000000000000000000000000000000000000aa";
const BITGO = "0x00000000000000000000000000000000000000bb";
const events = [
  ev({ type: "dex_sell", headline: true, amount: 5 }), ev({ type: "dex_sell", headline: true, amount: 7 }),
  ev({ type: "cex_deposit", headline: true, counterparty: "0xcex" }),
  ev({ type: "stable_out", asset: "stable", counterparty: SAFE, amount: 100 }), ev({ type: "stable_out", asset: "stable", counterparty: SAFE, amount: 50 }),
  ev({ type: "custody", counterparty: BITGO, hash: "0xonlyone", amount: 80 }),
  ev({ type: "internal_shuffle", internal: true }),
  ev({ type: "dex_sell", headline: true, time: NOW - 40 * 86400 }),
];
const s: WindowSummary = {
  from: "", to: "", devSold: { dex: 12, cex: 10, botDevShare: 3, total: 25 }, sellCount: 3, botSaleCount: 2, botSold: 9, sellDays: 1,
  internal: { count: 1, amount: 10 }, received: 0,
  payments: { stableOut: 150, stableOutCount: 2, stableIn: 0, stableInCount: 0, bySymbol: {},
    topStableRecipients: [{ address: SAFE, label: "Payroll multisig", asset: "stable", symbol: "USDC", type: "stable_out", count: 2, amount: 150, lastHash: null, lastTime: 0 }],
    topTokenDestinations: [{ address: BITGO, label: "BitGo custody", asset: "token", symbol: "TEL", type: "custody", count: 1, amount: 80, lastHash: "0xonlyone", lastTime: 0 }] },
  byType: {},
};
const report = {
  ticker: "TEL", generated: new Date(NOW * 1000).toISOString(), events, byWindow: { "30d": s }, headlines: {},
  developerWallets: [{ address: "0xdev", label: "Dev", group: null, entityClass: null, chains: ["polygon"], windows: {}, lastActivity: null }],
  botCluster: { label: "Bot", chain: "polygon", addresses: ["0xbot"], devShare: 0.35, evidence: [], windows: { "30d": { sold: 9, sales: 2, devShare: 3 } }, recentSales: [{ hash: "0xb1", time: NOW, amount: 1 }, { hash: "0xb2", time: NOW, amount: 1 }] },
} as unknown as LedgerReport;

const segs = (key: string) => summaryClaims(report, "30d").find((c) => c.key === key)!.segs.filter((x): x is Exclude<ClaimSeg, string> => typeof x !== "string");

describe("summaryClaims", () => {
  it("figures link to a type+window filter with proof txs", () => {
    const dex = segs("sold").find((x) => x.text.includes("on DEXs"))!;
    expect(dex).toMatchObject({ kind: "filter", count: 2, filter: { types: ["dex_sell"] } });
    if (dex.kind === "filter") expect(dex.txs.map((t) => t.chain)).toEqual(["polygon", "polygon"]);
    const direct = segs("freq").find((x) => x.text.includes("direct"))!;
    expect(direct).toMatchObject({ kind: "filter", count: 3, filter: { headline: true } }); // 40-day-old sale is outside 30d
    expect(segs("freq").find((x) => x.text.includes("bot sale"))).toMatchObject({ kind: "section", target: "pw-bot", count: 2 });
  });
  it("named entities link to their explorer address with chain", () => {
    expect(segs("paid").find((x) => x.text === "Payroll multisig")).toMatchObject({ kind: "address", address: SAFE, chain: "polygon" });
    expect(segs("dest").find((x) => x.text === "BitGo custody")).toMatchObject({ kind: "address", address: BITGO });
    expect(segs("sold").find((x) => x.text === "the bot cluster")).toMatchObject({ kind: "address", address: "0xbot" });
    expect(segs("sold")[0]).toMatchObject({ kind: "section", target: "pw-wallets", text: "Developer wallets" });
  });
  it("a single backing tx links straight to it, singular grammar", () => {
    expect(segs("dest").find((x) => x.text === "1 transfer")).toMatchObject({ kind: "tx", hash: "0xonlyone" });
    expect(segs("internal")[0]).toMatchObject({ kind: "tx", text: "1 internal shuffle" });
    expect(claimText(summaryClaims(report, "30d").find((c) => c.key === "dest")!)).not.toMatch(/1 transfers/);
  });
  it("plural + matchFilter", () => {
    expect(plural(1, "transfer")).toBe("1 transfer");
    expect(plural(1600, "payment")).toBe("1,600 payments");
    expect(matchFilter(events[3], { label: "", types: ["stable_out"], counterparty: SAFE.toUpperCase() })).toBe(true);
    expect(matchFilter(events[0], { label: "", internal: true })).toBe(false);
  });
});
