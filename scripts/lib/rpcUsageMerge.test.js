import { describe, expect, it } from "vitest";
import { aggregateRuns, mergeUsage } from "./runMetricsSummary.js";
import { mergeRpcUsage3 } from "./rpcUsageMerge.js";

const run = (script, o = {}) =>
  aggregateRuns([{ script, pid: 1, alchemyCu: 0, heliusCredits: 0, alchemyCalls: 0, heliusCalls: 0, publicCalls: 0, ...o }]);

describe("mergeRpcUsage3", () => {
  // The 2026-11-24 shape: the holders job and the ledger job each added a run to the same day.
  const base = mergeUsage(null, "2026-11-24", run("generate-wallet-flows-hedera.js", { publicCalls: 51 }));
  const holders = mergeUsage(base, "2026-11-24", run("pull-holders-rpc.js", { publicCalls: 101576 }));
  const ledger = mergeUsage(base, "2026-11-24", run("build-ledger.js", { publicCalls: 10 }));

  it("keeps both runs' counts on the same day (the nightly ledger vs holders race)", () => {
    const merged = mergeRpcUsage3(base, holders, ledger);
    const day = merged.days["2026-11-24"];
    expect(day).toMatchObject({ runs: 3, publicCalls: 51 + 101576 + 10, alchemyCu: 0, heliusCredits: 0 });
    expect(Object.keys(day.byScript).sort()).toEqual(["build-ledger.js", "generate-wallet-flows-hedera.js", "pull-holders-rpc.js"]);
    expect(day.byScript["build-ledger.js"]).toEqual({ processes: 1, alchemyCu: 0, heliusCredits: 0, publicCalls: 10 });
  });

  it("equals applying both runs one after the other (no count lost or doubled)", () => {
    const sequential = mergeUsage(holders, "2026-11-24", run("build-ledger.js", { publicCalls: 10 }));
    expect(mergeRpcUsage3(base, holders, ledger)).toEqual(sequential);
  });

  it("is symmetric in the two sides", () => {
    expect(mergeRpcUsage3(base, ledger, holders).days).toEqual(mergeRpcUsage3(base, holders, ledger).days);
  });

  it("does not drop a run when both sides made the identical edit (git would keep it once)", () => {
    const a = mergeUsage(base, "2026-11-24", run("x.js", { alchemyCu: 100 }));
    const b = mergeUsage(base, "2026-11-24", run("x.js", { alchemyCu: 100 }));
    expect(a).toEqual(b);
    const day = mergeRpcUsage3(base, a, b).days["2026-11-24"];
    expect(day.runs).toBe(3);
    expect(day.alchemyCu).toBe(200);
    expect(day.byScript["x.js"]).toMatchObject({ processes: 2, alchemyCu: 200 });
  });

  it("keeps Alchemy CU and Helius credits exact, so the budget guard's month-to-date stays complete", () => {
    const a = mergeUsage(base, "2026-11-24", run("pull.js", { alchemyCu: 618, alchemyCalls: 33 }));
    const b = mergeUsage(base, "2026-11-24", run("scan.js", { heliusCredits: 40, heliusCalls: 40, solanaBackupCu: 7 }));
    const day = mergeRpcUsage3(base, a, b).days["2026-11-24"];
    expect(day).toMatchObject({ alchemyCu: 618, alchemyCalls: 33, heliusCredits: 40, heliusCalls: 40, solanaBackupCu: 7 });
    expect(day.byScript["scan.js"].solanaBackupCu).toBe(7);
  });

  it("adds a new day from either side and handles a file new on both sides", () => {
    const a = mergeUsage(base, "2026-11-25", run("a.js", { publicCalls: 1 }));
    const b = mergeUsage(base, "2026-11-25", run("b.js", { publicCalls: 2 }));
    const merged = mergeRpcUsage3(base, a, b);
    expect(Object.keys(merged.days)).toEqual(["2026-11-24", "2026-11-25"]);
    expect(merged.days["2026-11-24"]).toEqual(base.days["2026-11-24"]);
    expect(merged.days["2026-11-25"]).toMatchObject({ runs: 2, publicCalls: 3 });

    const fresh = mergeRpcUsage3(null, mergeUsage(null, "2026-11-25", run("a.js", { publicCalls: 1 })), mergeUsage(null, "2026-11-25", run("b.js", { publicCalls: 2 })));
    expect(fresh.days["2026-11-25"]).toMatchObject({ runs: 2, publicCalls: 3 });
  });

  it("keeps a day pruned by one side pruned (62-day retention)", () => {
    const old = mergeUsage(null, "2026-09-01", run("a.js", { publicCalls: 5 }));
    const withToday = { ...old, days: { ...old.days, ...base.days } };
    const a = mergeUsage(withToday, "2026-11-24", run("a.js", { publicCalls: 1 })); // prunes 2026-09-01
    expect(a.days["2026-09-01"]).toBeUndefined();
    const b = { ...withToday, days: { ...withToday.days } }; // other side left the old day alone
    expect(Object.keys(mergeRpcUsage3(withToday, a, b).days)).toEqual(["2026-11-24"]);
  });

  it("throws instead of guessing on a file it does not understand", () => {
    expect(() => mergeRpcUsage3(base, { days: [] }, ledger)).toThrow(/not an rpc-usage file/);
    expect(() => mergeRpcUsage3(base, { schemaVersion: 1, days: { yesterday: {} } }, ledger)).toThrow(/unexpected day key/);
    expect(() => mergeRpcUsage3(base, { schemaVersion: 2, days: {} }, ledger)).toThrow(/schemaVersion/);
    const bad = structuredClone(holders);
    bad.days["2026-11-24"].runs = "two";
    expect(() => mergeRpcUsage3(base, bad, ledger)).toThrow(/not a number/);
    const shrunk = structuredClone(holders);
    shrunk.days["2026-11-24"].publicCalls = 0;
    expect(() => mergeRpcUsage3(base, shrunk, structuredClone(base))).not.toThrow();
    expect(() => mergeRpcUsage3(holders, shrunk, base)).toThrow(/negative/);
  });

  it("does not mutate its inputs", () => {
    const snapshot = JSON.stringify([base, holders, ledger]);
    mergeRpcUsage3(base, holders, ledger);
    expect(JSON.stringify([base, holders, ledger])).toBe(snapshot);
  });
});
