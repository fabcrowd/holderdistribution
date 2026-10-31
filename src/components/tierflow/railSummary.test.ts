import { describe, expect, it } from "vitest";
import type { Cause, Migration } from "./useFlowField";
import {
  flowSummaryRows, rankTiersByNet, tierKpis, tierSummaryRows, telFlowRows, topCounterparts, verdictTag, walletsFlowRows,
  type RailField,
} from "./railSummary";
import type { Formatters } from "./format";

const fmt: Formatters = {
  signed: (v, f) => `${v >= 0 ? "+" : "-"}${f(Math.abs(v))}`,
  fmtInt: (n) => String(Math.round(n)),
  fmtTel: (n) => `${Math.round(n)}T`,
};

const cause = (over: Partial<Cause> = {}): Cause => ({
  dex: 0, dexSwap: 0, dexLp: 0, cex: 0, moved: 0, splitTel: 0, splitDestinationSlots: 0, splitEvents: 0, soloMoved: 0,
  total: 0, sold: 0, soldPct: 0, hasData: false,
  boughtDex: 0, boughtDexSwap: 0, boughtDexLp: 0, boughtCex: 0, receivedWallet: 0, inTotal: 0, hasInData: false,
  inflowsBySourceTier: {}, movedByDestTier: {},
  ...over,
});

type Over = {
  count?: number; bal?: number; prevCount?: number | null; prevBal?: number | null;
  cause?: Cause; verdict?: RailField["verdict"]; addedCount?: number; removedCount?: number; migrations?: Migration[];
};

const field = (label: string, index: number, over: Over = {}): RailField => ({
  label,
  index,
  row: {
    label,
    count: over.count ?? 10,
    totalBalance: over.bal ?? 100,
    previousCount: over.prevCount === undefined ? 10 : over.prevCount,
    previousTotalBalance: over.prevBal === undefined ? 100 : over.prevBal,
  },
  cause: over.cause ?? cause(),
  verdict: over.verdict ?? "unknown",
  addedCount: over.addedCount ?? 0,
  removedCount: over.removedCount ?? 0,
  migrations: over.migrations ?? [],
});

describe("rankTiersByNet", () => {
  it("sorts by absolute net (joined - left) desc and breaks ties by tier index", () => {
    const fields = [
      field("A", 0, { addedCount: 12, removedCount: 10 }),
      field("B", 1, { addedCount: 5, removedCount: 10 }),
      field("C", 2, { addedCount: 2, removedCount: 0 }),
      field("D", 3, { addedCount: 30, removedCount: 20 }),
    ];
    expect(rankTiersByNet(fields, "wallets").map((r) => [r.label, r.net])).toEqual([["D", 10], ["B", -5], ["A", 2], ["C", 2]]);
  });
  it("ignores the snapshot baseline: a tier with no baseline still ranks by its flows", () => {
    const fields = [field("A", 0, { prevCount: null, addedCount: 1, removedCount: 4 }), field("B", 1, { addedCount: 1, removedCount: 0 })];
    const r = rankTiersByNet(fields, "wallets");
    expect(r.map((x) => [x.label, x.net, x.direction])).toEqual([["A", -3, "down"], ["B", 1, "up"]]);
  });
  it("ranks TEL by TEL in minus TEL out", () => {
    const fields = [
      field("A", 0, { cause: cause({ inTotal: 150, total: 100 }) }),
      field("B", 1, { cause: cause({ inTotal: 10, total: 100 }) }),
    ];
    expect(rankTiersByNet(fields, "tel").map((x) => x.net)).toEqual([-90, 50]);
  });
});

describe("tierKpis", () => {
  it("never shows a dagger or dash for net, even without a baseline", () => {
    const k = tierKpis(field("A", 0, { prevCount: null, prevBal: null, addedCount: 111, removedCount: 119 }), "wallets", { fmt });
    expect(k.find((x) => x.key === "netWallets")).toMatchObject({ text: "-8", tone: "negative" });
    expect(k.find((x) => x.key === "netTel")!.text).toBe("0");
  });
  it("20 in, 25 out reads -5; exactly zero reads 0", () => {
    expect(tierKpis(field("A", 0, { addedCount: 20, removedCount: 25 }), "wallets", { fmt }).find((x) => x.key === "netWallets")!.text).toBe("-5");
    expect(tierKpis(field("A", 0, { addedCount: 7, removedCount: 7 }), "wallets", { fmt }).find((x) => x.key === "netWallets")).toMatchObject({ text: "0", tone: "neutral" });
  });
  it("signs the net and puts the active metric first", () => {
    const f = field("A", 0, { addedCount: 14, removedCount: 10, cause: cause({ inTotal: 50, total: 80 }) });
    const w = tierKpis(f, "wallets", { fmt });
    expect(w[0].key).toBe("wallets");
    expect(w.find((x) => x.key === "netWallets")).toMatchObject({ text: "+4", tone: "positive" });
    const t = tierKpis(f, "tel", { fmt });
    expect(t[0].key).toBe("tel");
    expect(t.find((x) => x.key === "netTel")).toMatchObject({ text: "-30T", tone: "negative" });
  });
});

describe("missing feeds read as a dash, never 0", () => {
  const noTransitions = { hasTransitions: false, hasOutflows: true };
  const noOutflows = { hasTransitions: true, hasOutflows: false };
  const f = field("A", 0, { addedCount: 3, removedCount: 1, cause: cause({ inTotal: 5, total: 2 }) });
  it("tierKpis", () => {
    expect(tierKpis(f, "wallets", { fmt, avail: noTransitions }).find((x) => x.key === "netWallets")).toMatchObject({ text: "—", tone: "neutral" });
    expect(tierKpis(f, "wallets", { fmt, avail: noTransitions }).find((x) => x.key === "netTel")!.text).toBe("+3T");
    expect(tierKpis(f, "tel", { fmt, avail: noOutflows }).find((x) => x.key === "netTel")).toMatchObject({ text: "—", tone: "neutral" });
  });
  it("rankTiersByNet keeps tier order with null nets", () => {
    const r = rankTiersByNet([field("B", 1), field("A", 0)], "wallets", noTransitions);
    expect(r.map((x) => [x.label, x.net, x.direction])).toEqual([["A", null, "flat"], ["B", null, "flat"]]);
  });
  it("tierSummaryRows", () => {
    expect(tierSummaryRows([f], "wallets", fmt, noTransitions)[0].net).toBe("—");
    expect(tierSummaryRows([f], "tel", fmt, noOutflows)[0].net).toBe("—");
  });
});

describe("flowSummaryRows", () => {
  it("TEL: buy, sell and redistribution exclude LP so the three rows never overlap", () => {
    const f = field("A", 0, { cause: cause({ boughtDex: 12, boughtDexSwap: 5, boughtCex: 3, dex: 17, dexSwap: 4, cex: 2, boughtDexLp: 7, receivedWallet: 11, dexLp: 13, moved: 17 }) });
    const rows = flowSummaryRows(f, "tel", fmt);
    expect(rows.find((r) => r.key === "buy")).toMatchObject({ value: 8, text: "+8T" });
    expect(rows.find((r) => r.key === "sell")).toMatchObject({ value: 6, text: "-6T" });
    expect(rows.find((r) => r.key === "redistribution")).toMatchObject({ inValue: 18, outValue: 30, text: "+18T / -30T" });
  });
  it("Wallets: arrived and left come from the tick counts", () => {
    const rows = flowSummaryRows(field("A", 0, { addedCount: 12, removedCount: 5 }), "wallets", fmt);
    expect(rows.map((r) => [r.key, r.text])).toEqual([["arrived", "+12"], ["left", "-5"]]);
  });
});

describe("verdictTag", () => {
  it("maps verdicts to tags", () => {
    expect(verdictTag("sold")).toBe("mostly Sell");
    expect(verdictTag("relocated")).toBe("mostly Redistribution");
    expect(verdictTag("unknown")).toBeNull();
  });
});

const mig = (counterpart: string, count: number, gained: boolean, up = false): Migration => ({ counterpart, count, gained, up });

describe("topCounterparts", () => {
  it("ranks wallets counterparts by gross, including zero net", () => {
    const f = field("A", 0, { migrations: [mig("B", 5, true), mig("B", 5, false), mig("C", 3, true), mig("D", 1, false)] });
    const top = topCounterparts(f, "wallets", 2, fmt);
    expect(top.map((t) => [t.key, t.gross, t.net])).toEqual([["B", 10, 0], ["C", 3, 3]]);
    expect(top[0].text).toBe("+5 / -5");
  });
  it("ranks TEL causes by in plus out and skips empty ones", () => {
    const f = field("A", 0, { cause: cause({ boughtDexSwap: 10, dexSwap: 2, cex: 30 }) });
    const top = topCounterparts(f, "tel", 5, fmt);
    expect(top.map((t) => [t.key, t.gross])).toEqual([["cex", 30], ["dex", 12]]);
  });
});

describe("walletsFlowRows", () => {
  it("emits each crossing once, from the departing tier", () => {
    const a = field("A", 0, { migrations: [mig("B", 4, false)] });
    const b = field("B", 1, { migrations: [mig("A", 4, true), mig("C", 2, false)] });
    expect(walletsFlowRows([a, b])).toEqual([
      { from: "A", to: "B", wallets: 4 },
      { from: "B", to: "C", wallets: 2 },
    ]);
  });
});

describe("telFlowRows", () => {
  it("skips zeros and classifies each leg", () => {
    const f = field("A", 0, { cause: cause({ boughtDexSwap: 5, boughtDexLp: 2, dexSwap: 3, moved: 9 }) });
    expect(telFlowRows([f]).map((r) => [r.endpoint, r.direction, r.cls, r.amount])).toEqual([
      ["DEX", "In", "Buy", 5],
      ["Liquidity pool", "In", "Redistribution", 2],
      ["DEX", "Out", "Sell", 3],
      ["Wallet", "Out", "Redistribution", 9],
    ]);
  });
});

describe("tierSummaryRows", () => {
  it("wallets net is arrived minus left, never a dagger or dash", () => {
    const rows = tierSummaryRows(
      [field("A", 0, { count: 12, prevCount: 10, addedCount: 3, removedCount: 1 }), field("B", 1, { prevCount: null, addedCount: 2, removedCount: 5 }), field("C", 2)],
      "wallets", fmt,
    );
    expect(rows[0]).toMatchObject({ tier: "A", wallets: "12", net: "+2", arrived: "+3", left: "-1" });
    expect(rows[1]).toMatchObject({ tier: "B", net: "-3" });
    expect(rows[2]).toMatchObject({ tier: "C", net: "0" });
  });
  it("TEL rows carry buy, sell and redistribution columns", () => {
    const f = field("A", 0, { bal: 50, prevBal: 40, cause: cause({ boughtDex: 6, boughtDexSwap: 5, boughtCex: 3, dex: 6, dexSwap: 4, cex: 2, boughtDexLp: 1, receivedWallet: 1, dexLp: 2, moved: 2, inTotal: 10, total: 10 }) });
    expect(tierSummaryRows([f], "tel", fmt)[0]).toMatchObject({ tier: "A", held: "50T", net: "0", buy: "8T", sell: "6T", redistIn: "2T", redistOut: "4T" });
  });
});
