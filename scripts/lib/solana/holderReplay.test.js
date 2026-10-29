import { describe, expect, it } from "vitest";
import {
  buildDayEntry,
  cexBalanceAsOf,
  createReplayState,
  dayEndSeconds,
  estimateReplayCost,
  finalizeReplay,
  mergeHistoryEntries,
  nextUtcDate,
  replayTransactions,
  restoreReplayState,
  serializeReplayState,
  takeWholeSlots,
  trackedTokenAccounts,
  utcDateOf,
} from "./holderReplay.js";

// decimals 0 keeps raw units equal to whole tokens, so fixtures read directly.
const RETAIL_THRESHOLD = 10;
const at = (date, time = "12:00:00") => Date.parse(`${date}T${time}Z`) / 1000;
const deltas = (entries) => new Map(entries.map(([owner, v]) => [owner, BigInt(v)]));
const ctxWith = (nonRetail = new Set(), cexEntries = []) => ({
  chainKey: "solana",
  decimals: 0,
  nonRetail,
  retailThreshold: RETAIL_THRESHOLD,
  cexBalanceAsOf: cexBalanceAsOf(cexEntries),
});

describe("UTC day helpers", () => {
  it("maps seconds to UTC dates and gives exclusive day ends", () => {
    expect(utcDateOf(at("2026-03-01", "23:59:59"))).toBe("2026-03-01");
    expect(utcDateOf(at("2026-03-02", "00:00:00"))).toBe("2026-03-02");
    expect(dayEndSeconds("2026-03-01")).toBe(at("2026-03-02", "00:00:00"));
    expect(nextUtcDate("2026-02-28")).toBe("2026-03-01");
  });
});

describe("day snapshots", () => {
  it("snapshots the end-of-day state: a transaction at the day boundary belongs to the next day", () => {
    const ctx = ctxWith();
    const state = createReplayState();
    replayTransactions(
      state,
      [
        { blockTime: at("2026-01-01", "10:00:00"), deltas: deltas([["A", 100n]]) },
        { blockTime: at("2026-01-02", "00:00:00"), deltas: deltas([["B", 50n]]) },
      ],
      ctx,
    );
    finalizeReplay(state, at("2026-01-03", "00:00:00"), ctx);

    expect(state.entries.map((e) => e.date)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(state.entries[0].combined.holderCount).toBe(1);
    expect(state.entries[1].combined.holderCount).toBe(2);
  });

  it("does not emit a date until a later transaction or a finalized replay proves it ended", () => {
    const ctx = ctxWith();
    const state = createReplayState();
    replayTransactions(state, [{ blockTime: at("2026-01-01", "10:00:00"), deltas: deltas([["A", 1n]]) }], ctx);
    expect(state.entries).toEqual([]);

    replayTransactions(state, [{ blockTime: at("2026-01-03", "09:00:00"), deltas: deltas([["A", 1n]]) }], ctx);
    expect(state.entries.map((e) => e.date)).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("counts new holders once, tracks cumulative holders, and classifies retail vs under-threshold", () => {
    const ctx = ctxWith(new Set(["X"]));
    const state = createReplayState();
    replayTransactions(
      state,
      [
        // X is a CEX owner: its outflow is not tracked, A's inflow is.
        { blockTime: at("2026-03-01", "12:00:00"), deltas: deltas([["A", 100n], ["X", -100n]]) },
        // A -> C: C arrives under the retail threshold, A drops under it.
        { blockTime: at("2026-03-02", "09:00:00"), deltas: deltas([["A", -95n], ["C", 95n]]) },
      ],
      ctx,
    );
    finalizeReplay(state, at("2026-03-04", "00:00:00"), ctx);

    const [day1, day2, day3] = state.entries;
    expect(state.entries.map((e) => e.date)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    expect(day1.combined).toMatchObject({ holderCount: 1, retailHolderCount: 1 });
    expect(day1).toMatchObject({ newHolders: 1, cumulativeHolders: 1 });
    expect(day2.combined).toMatchObject({ holderCount: 2, retailHolderCount: 1 });
    expect(day2).toMatchObject({ newHolders: 1, cumulativeHolders: 2 });
    expect(day3).toMatchObject({ newHolders: 0, cumulativeHolders: 2 });
    expect(state.firstSeen.get("A")).toBe("2026-03-01");
    expect(state.firstSeen.has("X")).toBe(false);
  });

  it("re-entering holder is not new again", () => {
    const ctx = ctxWith();
    const state = createReplayState();
    replayTransactions(
      state,
      [
        { blockTime: at("2026-03-01"), deltas: deltas([["A", 20n]]) },
        { blockTime: at("2026-03-02"), deltas: deltas([["A", -20n]]) },
        { blockTime: at("2026-03-03"), deltas: deltas([["A", 20n]]) },
      ],
      ctx,
    );
    finalizeReplay(state, at("2026-03-05"), ctx);
    expect(state.entries.map((e) => [e.date, e.newHolders, e.cumulativeHolders])).toEqual([
      ["2026-03-01", 1, 1],
      // 2026-03-02 has no holders: skipped, as the live pipeline skips empty snapshots.
      ["2026-03-03", 0, 1],
      ["2026-03-04", 0, 1],
    ]);
  });

  it("skips dates with nobody holding anything and emits quiet days that still hold", () => {
    const ctx = ctxWith();
    const state = createReplayState();
    replayTransactions(
      state,
      [
        { blockTime: at("2026-04-01", "08:00:00"), deltas: deltas([["A", 10n]]) },
        { blockTime: at("2026-04-03", "08:00:00"), deltas: deltas([["A", -10n]]) },
      ],
      ctx,
    );
    finalizeReplay(state, at("2026-04-05"), ctx);
    expect(state.entries.map((e) => e.date)).toEqual(["2026-04-01", "2026-04-02"]);
  });

  it("counts balances that go negative as anomalies instead of hiding them", () => {
    const state = createReplayState();
    replayTransactions(state, [{ blockTime: at("2026-05-01"), deltas: deltas([["A", -5n]]) }], ctxWith());
    expect(state.anomalies).toBe(1);
  });

  it("flags transactions that arrive out of time order", () => {
    const state = createReplayState();
    replayTransactions(
      state,
      [
        { blockTime: at("2026-05-02"), deltas: deltas([["A", 1n]]) },
        { blockTime: at("2026-05-01"), deltas: deltas([["B", 1n]]) },
      ],
      ctxWith(),
    );
    expect(state.outOfOrder).toBe(1);
  });

  it("gives the same entries when a checkpoint is saved and restored between runs", () => {
    const ctx = ctxWith(new Set(["X"]));
    const txs = [
      { blockTime: at("2026-06-01", "10:00:00"), deltas: deltas([["A", 30n], ["X", -30n]]) },
      { blockTime: at("2026-06-02", "10:00:00"), deltas: deltas([["A", -10n], ["B", 10n]]) },
      { blockTime: at("2026-06-04", "10:00:00"), deltas: deltas([["B", -10n], ["C", 10n]]) },
      { blockTime: at("2026-06-05", "10:00:00"), deltas: deltas([["C", 3n]]) },
    ];
    const whole = finalizeReplay(replayTransactions(createReplayState(), txs, ctx), at("2026-06-07"), ctx);

    const firstRun = replayTransactions(createReplayState(), txs.slice(0, 2), ctx);
    const saved = JSON.parse(JSON.stringify(serializeReplayState(firstRun)));
    const resumed = finalizeReplay(replayTransactions(restoreReplayState(saved), txs.slice(2), ctx), at("2026-06-07"), ctx);

    expect(resumed.entries).toEqual(whole.entries);
    expect(resumed.cumulativeHolders).toBe(whole.cumulativeHolders);
    expect([...resumed.firstSeen]).toEqual([...whole.firstSeen]);
  });
});

describe("buildDayEntry", () => {
  it("writes the holders-history schema under the chain key with the CEX balance and total held", () => {
    const entry = buildDayEntry({
      chainKey: "solana",
      date: "2026-07-01",
      holders: [
        { address: "A", balance: 100 },
        { address: "B", balance: 4 },
      ],
      cexBalance: 1000,
      newHolders: 2,
      cumulativeHolders: 2,
      retailThreshold: RETAIL_THRESHOLD,
    });
    expect(entry.date).toBe("2026-07-01");
    expect(entry.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(entry.combined).toMatchObject({
      holderCount: 2,
      retailHolderCount: 1,
      totalBalance: 104,
      holderCountWithStakers: 2,
      cexBalance: 1000,
      totalHeld: 1104,
    });
    expect(entry.chains.solana).toMatchObject({ holderCount: 2, retailHolderCount: 1, totalBalance: 104 });
    expect(entry.concentration[10]).toBe(104);
  });
});

describe("cexBalanceAsOf", () => {
  it("carries the latest balance forward and never fabricates a zero before the first entry", () => {
    const asOf = cexBalanceAsOf([
      { date: "2026-03-01", total: 100 },
      { date: "2026-03-05", total: 200 },
    ]);
    expect(asOf("2026-02-01")).toBe(100);
    expect(asOf("2026-03-03")).toBe(100);
    expect(asOf("2026-03-06")).toBe(200);
    expect(cexBalanceAsOf([])("2026-03-06")).toBe(0);
  });
});

describe("mergeHistoryEntries", () => {
  it("replaces replayed dates, keeps other rows, and carries the staking figure for replayed dates", () => {
    const existing = [
      { date: "2026-03-01", combined: { holderCount: 1, stakingV3Balance: 7 } },
      { date: "2026-03-09", combined: { holderCount: 5 } },
    ];
    const replay = [{ date: "2026-03-01", combined: { holderCount: 2 } }];
    const merged = mergeHistoryEntries(existing, replay);
    expect(merged.map((e) => e.date)).toEqual(["2026-03-01", "2026-03-09"]);
    expect(merged[0].combined).toEqual({ holderCount: 2, stakingV3Balance: 7 });
    expect(merged[1]).toBe(existing[1]);
  });
});

describe("trackedTokenAccounts", () => {
  const row = (pubkey, owner, amount, mint = "MINT") => ({
    pubkey,
    account: { data: { parsed: { info: { mint, owner, tokenAmount: { amount } } } } },
  });

  it("keeps retail owners of the mint, including zero-balance accounts, and drops the rest", () => {
    const rows = [
      row("acctA", "A", "0"),
      row("acctB", "B", "5"),
      row("acctX", "X", "9"),
      row("acctOther", "A", "1", "OTHER"),
    ];
    expect(trackedTokenAccounts(rows, { mint: "MINT", nonRetail: new Set(["X"]) })).toEqual([
      { account: "acctA", owner: "A", raw: 0n },
      { account: "acctB", owner: "B", raw: 5n },
    ]);
  });
});

describe("takeWholeSlots", () => {
  it("never splits a slot across two runs", () => {
    const sorted = [{ slot: 1 }, { slot: 1 }, { slot: 2 }, { slot: 2 }, { slot: 3 }];
    expect(takeWholeSlots(sorted, 2)).toHaveLength(2);
    expect(takeWholeSlots(sorted, 3)).toHaveLength(4);
    expect(takeWholeSlots(sorted, 0)).toEqual([]);
  });
});

describe("estimateReplayCost", () => {
  it("counts runs, per-run calls and total calls from tracked accounts and signatures", () => {
    const est = estimateReplayCost({ trackedAccounts: 1000, meanSignaturesPerAccount: 10, maxTx: 5000, requestsPerSecond: 10 });
    expect(est.signatures).toBe(10_000);
    expect(est.runsToCatchUp).toBe(2);
    expect(est.callsPerRun).toBe(6001);
    expect(est.totalCalls).toBe(2 * 1001 + 10_000);
    expect(est.hoursPerRunAt).toBeCloseTo(6001 / 10 / 3600, 6);
  });
});
