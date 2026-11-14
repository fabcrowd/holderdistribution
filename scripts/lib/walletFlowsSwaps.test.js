import { describe, it, expect } from "vitest";
import { SWAP_TOPICS } from "./walletFlows.js";
import { markSwaps } from "./walletFlowsSwaps.js";
import { buildState, mergeEvents, planChainScan, scanChainOutflows } from "./walletFlowsState.js";

const SWAP = [...SWAP_TOPICS.keys()][0];
const ev = (block, tx, extra = {}) => ({ chain: "ethereum", from: "0xa", to: "0xb", tel: 2e6, tx, block, logIndex: 0, ...extra });
const receipt = (topic) => ({ logs: [{ topics: [topic] }] });

describe("markSwaps (tri-state)", () => {
  it("sets true on a swap receipt, false on a clean one, null on error", async () => {
    const transfers = [ev(1, "0x1"), ev(2, "0x2"), ev(3, "0x3")];
    const fetchReceipt = async (tx) => {
      if (tx === "0x1") return receipt(SWAP);
      if (tx === "0x2") return receipt("0xdead");
      throw new Error("rpc down");
    };
    await markSwaps({ fetchReceipt, transfers, budget: { left: 10 } });
    expect(transfers.map((t) => t.swapped)).toEqual([true, false, null]);
  });

  it("leaves transfers beyond the budget null and flags the budget exhausted", async () => {
    const transfers = [ev(1, "0x1"), ev(2, "0x2")];
    const budget = { left: 1 };
    await markSwaps({ fetchReceipt: async () => receipt("0xdead"), transfers, budget });
    // Newest-first: the budget goes to block 2.
    expect(transfers.map((t) => t.swapped)).toEqual([null, false]);
    expect(budget.exhausted).toBe(true);
  });

  it("reuses true/false verdicts and re-checks null and absent ones", async () => {
    const seen = [];
    const transfers = [ev(1, "0x1", { swapped: true }), ev(2, "0x2", { swapped: false }), ev(3, "0x3", { swapped: null }), ev(4, "0x4")];
    await markSwaps({ fetchReceipt: async (tx) => (seen.push(tx), receipt(SWAP)), transfers, budget: { left: 10 } });
    expect(seen.sort()).toEqual(["0x3", "0x4"]);
    expect(transfers.map((t) => t.swapped)).toEqual([true, false, true, true]);
  });
});

describe("markSwaps retries and drops", () => {
  it("treats a null receipt like an error: keeps the event and counts an attempt", async () => {
    const t = ev(1, "0x1");
    await markSwaps({ fetchReceipt: async () => null, transfers: [t], budget: { left: 10 } });
    expect(t).toMatchObject({ swapped: null, swapAttempts: 1 });
  });

  it("gives up after 3 failed attempts, visibly", async () => {
    const t = ev(1, "0x1");
    const fail = async () => { throw new Error("down"); };
    for (let i = 0; i < 2; i++) await markSwaps({ fetchReceipt: fail, transfers: [t], budget: { left: 10 } });
    expect(t).toMatchObject({ swapped: null, swapAttempts: 2 });
    await markSwaps({ fetchReceipt: fail, transfers: [t], budget: { left: 10 } });
    expect(t).toMatchObject({ swapped: false, swapCheck: "gave-up" });
    const seen = [];
    await markSwaps({ fetchReceipt: async (tx) => (seen.push(tx), receipt(SWAP)), transfers: [t], budget: { left: 0 } });
    expect(seen).toEqual([]);
    expect(t).toMatchObject({ swapped: false, swapCheck: "gave-up" });
  });

  it("retries a gave-up event with leftover budget and replaces its verdict when it resolves", async () => {
    const t = ev(1, "0x1", { swapped: false, swapCheck: "gave-up" });
    const budget = { left: 5 };
    await markSwaps({ fetchReceipt: async () => receipt(SWAP), transfers: [t], budget });
    expect(t.swapped).toBe(true);
    expect(t.swapCheck).toBeUndefined();
    expect(budget.left).toBe(4);
  });

  it("a gave-up retry that fails again stays gave-up without flagging the budget exhausted", async () => {
    const t = ev(1, "0x1", { swapped: false, swapCheck: "gave-up" });
    const budget = { left: 5 };
    await markSwaps({ fetchReceipt: async () => { throw new Error("down"); }, transfers: [t], budget });
    expect(t).toMatchObject({ swapped: false, swapCheck: "gave-up" });
    expect(t.swapAttempts).toBeUndefined();
    expect(budget.exhausted).toBeUndefined();
  });

  it("never spends budget on gave-up events while new candidates need it", async () => {
    const seen = [];
    const old = ev(1, "0xold", { swapped: false, swapCheck: "gave-up" });
    const fresh = [ev(900, "0xnew1"), ev(901, "0xnew2")];
    await markSwaps({ fetchReceipt: async (tx) => (seen.push(tx), receipt("0xdead")), transfers: [old, ...fresh], budget: { left: 2 } });
    expect(seen.sort()).toEqual(["0xnew1", "0xnew2"]);
    expect(old).toMatchObject({ swapped: false, swapCheck: "gave-up" });
    // Budget short for the new ones: still nothing for the gave-up event.
    const seen2 = [];
    const t2 = [ev(1, "0xg", { swapped: false, swapCheck: "gave-up" }), ev(5, "0xa"), ev(6, "0xb")];
    await markSwaps({ fetchReceipt: async (tx) => (seen2.push(tx), receipt("0xdead")), transfers: t2, budget: { left: 1 } });
    expect(seen2).toEqual(["0xb"]);
  });

  it("checks newest candidates first when the budget is smaller than the pending set", async () => {
    const seen = [];
    const transfers = [ev(1, "0xold1", { swapped: null }), ev(2, "0xold2", { swapped: null }), ev(900, "0xnew")];
    await markSwaps({ fetchReceipt: async (tx) => (seen.push(tx), receipt("0xdead")), transfers, budget: { left: 1 } });
    expect(seen).toEqual(["0xnew"]);
  });
});

describe("mergeEvents carries verdicts", () => {
  it("copies a stored verdict onto the fresh copy of the same tx:logIndex", () => {
    const merged = mergeEvents([ev(20, "0x20", { swapped: true })], [ev(20, "0x20")], { from: 10, start90: 0 });
    expect(merged[0].swapped).toBe(true);
  });
});

describe("scanChainOutflows", () => {
  const hash = "h";
  const chain = "ethereum";
  const chainEvents = [ev(100, "0xa1"), ev(200, "0xa2")];
  const scan = async (from, to) => chainEvents.filter((e) => e.block >= from && e.block <= to).map((e) => ({ ...e }));
  const markWith = (fetchReceipt) => (events) => markSwaps({ fetchReceipt, transfers: events, budget: { left: 10 } });

  it("labels an event on run 2 that failed its receipt on run 1", async () => {
    const run1 = await scanChainOutflows({ state: null, chain, hash, start90: 0, head: 300, scan, mark: markWith(async () => { throw new Error("down"); }) });
    expect(run1.events.map((e) => e.swapped)).toEqual([null, null]);
    const state = buildState({ hash, chains: { [chain]: run1.entry } });
    const run2 = await scanChainOutflows({ state, chain, hash, start90: 0, head: 400, scan, mark: markWith(async () => receipt(SWAP)) });
    expect(run2.plan.full).toBe(false);
    expect(run2.events.map((e) => e.swapped)).toEqual([true, true]);
  });

  it("a deep reorg inside the confirmation depth removes the stored event", async () => {
    // Polygon's confirmation depth is 128, so cursor - 100 is re-read.
    const state = buildState({ hash, chains: { polygon: { cursor: 1000, events: [ev(900, "0xgone", { chain: "polygon" })] } } });
    const run = await scanChainOutflows({ state, chain: "polygon", hash, start90: 0, head: 1100, scan: async () => [], mark: async () => {} });
    expect(run.events).toEqual([]);
  });

  it("keeps an event whose receipt is null (flaky node), counting an attempt", async () => {
    const mark = (events) => markSwaps({ fetchReceipt: async () => null, transfers: events, budget: { left: 10 } });
    const run = await scanChainOutflows({ state: null, chain, hash, start90: 0, head: 300, scan, mark });
    expect(run.events.map((e) => e.swapAttempts)).toEqual([1, 1]);
    expect(run.entry.events).toHaveLength(2);
  });

  it("propagates a failed fetch so the caller never builds new state", async () => {
    await expect(
      scanChainOutflows({ state: null, chain, hash, start90: 0, head: 300, scan: async () => { throw new Error("rpc down"); }, mark: async () => {} }),
    ).rejects.toThrow("rpc down");
  });

  it("scans from cursor + 1 - confirmations (production overlap)", () => {
    const state = buildState({ hash, chains: { [chain]: { cursor: 1000, events: [] } } });
    expect(planChainScan({ state, chain, hash, start90: 0, head: 1100 }).from).toBe(1000 + 1 - 64);
    expect(planChainScan({ state, chain: "polygon", hash, start90: 0, head: 1100 }).full).toBe(true);
  });
});
