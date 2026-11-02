import { describe, expect, it } from "vitest";
import { buildSalesJournal } from "./salesJournal.js";
import { STABLE_MINTS, WSOL_MINT, symbolOf } from "./knownMints.js";

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86400;
const ZBCN_DECIMALS = 9;

// Synthetic base58-looking addresses; no real accounts.
const WALLET = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const CEX_HOT = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const ZBCN_MINT = "ZbCnMint1111111111111111111111111111111111";
const UNKNOWN_MINT = "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w";
const USDC_MINT = STABLE_MINTS.USDC.mint;

const REGISTRY = { knownWallets: [{ address: WALLET, label: "Treasury desk" }] };

const usdcLeg = (raw, holder = "wallet") => ({
  mint: USDC_MINT,
  raw,
  decimals: 6,
  holder,
  owner: WALLET,
  account: null,
  source: "token",
});
const solLeg = (raw) => ({
  mint: WSOL_MINT,
  raw,
  decimals: 9,
  holder: "wallet",
  owner: WALLET,
  account: null,
  source: "native",
});
const unknownLeg = (raw) => ({
  mint: UNKNOWN_MINT,
  raw,
  decimals: 6,
  holder: "wallet",
  owner: WALLET,
  account: null,
  source: "token",
});

function makeSale(overrides = {}) {
  return {
    sig: "SALE1",
    t: NOW - DAY,
    wallet: WALLET,
    dex: ["raydium"],
    soldRaw: "1000000000",
    legs: [usdcLeg("2500000")],
    ...overrides,
  };
}

function journal(sales, { tasks = {}, hops = [], ...options } = {}) {
  return buildSalesJournal({
    sales,
    follow: { tasks, hops },
    registry: REGISTRY,
    nowSec: NOW,
    zbcnDecimals: ZBCN_DECIMALS,
    ...options,
  });
}

const saleTask = (overrides = {}) => ({
  id: "sale-task",
  kind: "sale",
  ref: "SALE1|" + WALLET,
  rootWallet: WALLET,
  owner: WALLET,
  account: null,
  mint: ZBCN_MINT,
  decimals: ZBCN_DECIMALS,
  sinceSec: NOW - DAY,
  remaining: "0",
  depth: 0,
  until: NOW,
  status: "done",
  ...overrides,
});

const cexHop = (overrides = {}) => ({
  taskId: "sale-task",
  depth: 1,
  from: WALLET,
  to: CEX_HOT,
  kind: "CEX",
  venue: "MEXC",
  mint: ZBCN_MINT,
  raw: "400000000",
  t: NOW - DAY + HOUR,
  sig: "HOP1",
  ...overrides,
});

describe("symbolOf", () => {
  it("maps the known stable mints and WSOL, and nothing else", () => {
    expect(symbolOf(STABLE_MINTS.USDC.mint)).toBe("USDC");
    expect(symbolOf(STABLE_MINTS.USDT.mint)).toBe("USDT");
    expect(symbolOf(WSOL_MINT)).toBe("SOL");
    expect(symbolOf(UNKNOWN_MINT)).toBeNull();
    expect(symbolOf(STABLE_MINTS.USDC.mint.toLowerCase())).toBeNull();
  });
});

describe("buildSalesJournal", () => {
  it("returns null when there are no sales or none within 90 days", () => {
    expect(journal([])).toBeNull();
    expect(journal([makeSale({ t: NOW - 91 * DAY })])).toBeNull();
  });

  it("excludes sales older than 90 days from rows and totals", () => {
    const result = journal([makeSale({ sig: "FRESH" }), makeSale({ sig: "OLD", t: NOW - 100 * DAY })]);
    expect(result.totals.count).toBe(1);
    expect(result.sales.map((s) => s.sig)).toEqual(["FRESH"]);
  });

  it("values a USDC leg at its stable amount", () => {
    const [row] = journal([makeSale()]).sales;
    expect(row.proceeds[0]).toMatchObject({ symbol: "USDC", amount: 2.5, usd: 2.5 });
    expect(row.proceedsUsd).toBe(2.5);
    expect(row.zbcnSold).toBe(1);
    expect(row.effectivePriceUsd).toBe(2.5);
  });

  it("leaves SOL unvalued and the journal unvalued at report time when solUsd is 0", () => {
    const result = journal([makeSale({ legs: [solLeg("2000000000")] })], { solUsd: 0 });
    const [row] = result.sales;
    expect(row.proceeds[0].usd).toBeNull();
    expect(row.proceedsUsd).toBeNull();
    expect(row.effectivePriceUsd).toBeNull();
    expect(result.valuedAtReportTime).toBe(false);
  });

  it("values SOL only when solUsd is positive and reports it", () => {
    const result = journal([makeSale({ legs: [solLeg("2000000000")] })], { solUsd: 150 });
    const [row] = result.sales;
    expect(row.proceeds[0].usd).toBe(300);
    expect(row.proceedsUsd).toBe(300);
    expect(result.valuedAtReportTime).toBe(true);
  });

  it("returns a null proceedsUsd for an unknown mint", () => {
    const [row] = journal([makeSale({ legs: [unknownLeg("5000000")] })]).sales;
    expect(row.proceeds[0]).toMatchObject({ symbol: null, usd: null });
    expect(row.proceedsUsd).toBeNull();
  });

  it("nulls the effective price when any leg is unvalued", () => {
    const [row] = journal([makeSale({ legs: [usdcLeg("2500000"), unknownLeg("5000000")] })]).sales;
    expect(row.proceeds[0].usd).toBe(2.5);
    expect(row.proceedsUsd).toBeNull();
    expect(row.effectivePriceUsd).toBeNull();
  });

  it("nulls the effective price when no ZBCN was sold", () => {
    const [row] = journal([makeSale({ soldRaw: "0" })]).sales;
    expect(row.zbcnSold).toBe(0);
    expect(row.effectivePriceUsd).toBeNull();
  });

  it("uses wallet-held legs as proceeds, falling back to other-held legs only when none exist", () => {
    const mixed = journal([makeSale({ legs: [usdcLeg("2500000"), usdcLeg("9000000", "other")] })]).sales[0];
    expect(mixed.proceeds).toHaveLength(1);
    expect(mixed.proceedsUsd).toBe(2.5);

    const otherOnly = journal([makeSale({ legs: [usdcLeg("9000000", "other")] })]).sales[0];
    expect(otherOnly.proceeds).toHaveLength(1);
    expect(otherOnly.proceedsUsd).toBe(9);
  });

  it("caps rows at the limit, newest first, while totals cover every sale", () => {
    const sales = [0, 1, 2, 3, 4].map((k) => makeSale({ sig: `S${k}`, t: NOW - k * HOUR }));
    const result = journal(sales, { limit: 2 });
    expect(result.sales.map((s) => s.sig)).toEqual(["S0", "S1"]);
    expect(result.totals.count).toBe(5);
    expect(result.totals.zbcnSold).toBe(5);
  });

  it("reports complete onward status and attaches hops for a done sale task", () => {
    const [row] = journal([makeSale()], { tasks: { "sale-task": saleTask() }, hops: [cexHop()] }).sales;
    expect(row.onwardStatus).toBe("complete");
    expect(row.onward).toHaveLength(1);
    expect(row.onward[0]).toMatchObject({ hop: 1, kind: "CEX", venue: "MEXC", amount: 0.4, sig: "HOP1" });
  });

  it("reports partial onward status while a related task is still busy", () => {
    const tasks = { "sale-task": saleTask({ status: "busy" }) };
    const [row] = journal([makeSale()], { tasks, hops: [cexHop()] }).sales;
    expect(row.onwardStatus).toBe("partial");
  });

  it("reports none-seen when a finished sale task found no hops", () => {
    const [row] = journal([makeSale()], { tasks: { "sale-task": saleTask() } }).sales;
    expect(row.onwardStatus).toBe("none-seen");
    expect(row.onward).toEqual([]);
  });

  it("reports untracked when SOL proceeds have no hops", () => {
    const [row] = journal([makeSale({ legs: [solLeg("2000000000")] })], {
      tasks: { "sale-task": saleTask() },
    }).sales;
    expect(row.onwardStatus).toBe("untracked");
  });

  it("survives a JSON round trip unchanged", () => {
    const result = journal([makeSale(), makeSale({ sig: "S2", t: NOW - 2 * HOUR, legs: [solLeg("1000000000")] })], {
      tasks: { "sale-task": saleTask() },
      hops: [cexHop()],
      solUsd: 100,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
