import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __resetBudgetGuardForTests, __resetRpcMetricsForTests, alchemyBlocked, guardAlchemyCall, isAlchemyBudgetError, recordCall, resolveJobEnv } from "./rpcMetrics.js";

const A = "https://polygon-mainnet.g.alchemy.com/v2/k";
afterEach(() => {
  __resetRpcMetricsForTests();
  __resetBudgetGuardForTests();
});

describe("Alchemy budget guard", () => {
  it("is a no-op outside a nightly job step", () => {
    for (let i = 0; i < 100; i++) recordCall(A, "alchemy_getAssetTransfers");
    expect(() => guardAlchemyCall("eth_call", {})).not.toThrow();
    expect(alchemyBlocked({})).toBe(false);
  });

  it("enforce: refuses the call that would cross the per-run budget", () => {
    const env = { HD_JOB_ID: "t", HD_JOB_ALCHEMY_CU_BUDGET: "100", HD_JOB_BUDGET_MODE: "enforce" };
    expect(() => guardAlchemyCall("eth_call", env)).not.toThrow();
    for (let i = 0; i < 3; i++) recordCall(A, "eth_call"); // 78 CU
    let err;
    try {
      guardAlchemyCall("eth_call", env);
    } catch (e) {
      err = e;
    }
    expect(isAlchemyBudgetError(err)).toBe(true);
    expect(alchemyBlocked({ ...env, HD_JOB_ALCHEMY_CU_BUDGET: "50" })).toBe(true);
  });

  it("warn: logs but lets the call through", () => {
    const env = { HD_JOB_ID: "t", HD_JOB_ALCHEMY_CU_BUDGET: "0", HD_JOB_BUDGET_MODE: "warn" };
    expect(() => guardAlchemyCall("eth_call", env)).not.toThrow();
    expect(alchemyBlocked(env)).toBe(false);
  });

  it("a 0-CU enforced job is blocked from the first Alchemy call", () => {
    expect(alchemyBlocked({ HD_JOB_ID: "t", HD_JOB_ALCHEMY_CU_BUDGET: "0", HD_JOB_BUDGET_MODE: "enforce" })).toBe(true);
  });

  it("fills budget, mode and alchemyOnly from config/nightly-jobs.json when only HD_JOB_ID is set", () => {
    expect(resolveJobEnv({ HD_JOB_ID: "ledger" })).toMatchObject({ HD_JOB_ALCHEMY_CU_BUDGET: "0", HD_JOB_BUDGET_MODE: "enforce", HD_JOB_ALCHEMY_ONLY: "false" });
    expect(resolveJobEnv({ HD_JOB_ID: "history-gaps" })).toMatchObject({ HD_JOB_ALCHEMY_ONLY: "true", HD_JOB_BUDGET_MODE: "warn" });
  });

  it("monthly ceiling: sums every project's rpc-usage.json for this month", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
    const month = new Date().toISOString().slice(0, 7);
    fs.mkdirSync(path.join(root, "config"));
    fs.mkdirSync(path.join(root, "data/ondo"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/budgets.json"), JSON.stringify({ monthly: { alchemyCu: 1000 } }));
    fs.writeFileSync(path.join(root, "data/rpc-usage.json"), JSON.stringify({ days: { [`${month}-01`]: { alchemyCu: 600 } } }));
    fs.writeFileSync(path.join(root, "data/ondo/rpc-usage.json"), JSON.stringify({ days: { [`${month}-02`]: { alchemyCu: 390 } } }));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const env = { HD_JOB_ID: "t", HD_JOB_ALCHEMY_CU_BUDGET: "100000", HD_JOB_BUDGET_MODE: "enforce" };
      expect(() => guardAlchemyCall("eth_blockNumber", env)).not.toThrow(); // 990 + 10
      expect(() => guardAlchemyCall("eth_call", env)).toThrow(/monthly Alchemy ceiling/);
    } finally {
      process.chdir(cwd);
    }
  });
});
