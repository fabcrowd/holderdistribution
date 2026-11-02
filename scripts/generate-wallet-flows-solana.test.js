/**
 * Pure helpers of generate-wallet-flows-solana.js: token balance parsing from a
 * getTokenAccountsByOwner (jsonParsed) response, the budget guard decision and the
 * dry-run summary. No network: importing the module runs nothing.
 */
import { describe, it, expect } from "vitest";
import {
  attachSections,
  dryRunLines,
  followLimits,
  overBudget,
  rawTokenBalance,
  uiAmount,
} from "./generate-wallet-flows-solana.js";
import { buildSalesJournal } from "./lib/solana/salesJournal.js";
import { buildUnlabelledTrace } from "./lib/solana/unlabelledTrace.js";
import { validateWalletFlowsReport } from "./lib/walletFlows.js";

const account = (amount) => ({
  pubkey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  account: { data: { parsed: { info: { mint: "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU", tokenAmount: { amount, decimals: 6, uiAmount: null } } } } },
});

const BUDGETS = { monthly: { heliusCredits: 1_000_000 }, perRunWarn: { heliusCredits: 100_000 } };

describe("rawTokenBalance", () => {
  it("sums every token account of the wallet as BigInt", () => {
    const response = { context: { slot: 1 }, value: [account("1500000000"), account("250000000000000000001")] };
    expect(rawTokenBalance(response)).toBe(250000000000000000001n + 1500000000n);
  });

  it("returns 0 for a wallet with no token accounts", () => {
    expect(rawTokenBalance({ context: { slot: 1 }, value: [] })).toBe(0n);
    expect(rawTokenBalance({ context: { slot: 1 }, value: null })).toBe(0n);
  });

  it("throws on an account without a parsed amount instead of counting it as zero", () => {
    const broken = { pubkey: "x", account: { data: { parsed: { info: {} } } } };
    expect(() => rawTokenBalance({ value: [broken] })).toThrow(/tokenAmount.amount/);
  });

  it("converts smallest units to UI units with the chain decimals", () => {
    expect(uiAmount(rawTokenBalance({ value: [account("1500000000")] }), 6)).toBe(1500);
    expect(uiAmount(0n, 6)).toBe(0);
  });
});

describe("overBudget", () => {
  it("stops a run whose estimate is above the per-run warning", () => {
    expect(overBudget(100_001, BUDGETS)).toBe(true);
  });

  it("allows an estimate exactly at the warning and below it", () => {
    expect(overBudget(100_000, BUDGETS)).toBe(false);
    expect(overBudget(0, BUDGETS)).toBe(false);
  });

  it("is overridden by --force", () => {
    expect(overBudget(5_000_000, BUDGETS, true)).toBe(false);
  });
});

describe("dryRunLines", () => {
  it("prints one label line per wallet and a total with the monthly share, never RPC data", () => {
    const labels = new Map([
      ["AAA111", "Team wallet"],
      ["BBB222", "Ops wallet"],
    ]);
    const lines = dryRunLines({
      labels,
      counts: { signatures: 7, perWallet: { AAA111: 5, BBB222: 2 }, transactions: 0 },
      estimatedCredits: 7000,
      budgets: BUDGETS,
    });
    expect(lines[0]).toBe("  Team wallet: 5 signatures");
    expect(lines[1]).toBe("  Ops wallet: 2 signatures");
    expect(lines[2]).toContain("Total: 7 unique signatures, ~7000 Helius credits");
    expect(lines[2]).toContain("0.70% of the 1000000 monthly allowance");
    expect(lines.at(-1)).toBe("Dry run: nothing written.");
  });

  it("lists a wallet with no signatures as 0", () => {
    const lines = dryRunLines({
      labels: new Map([["CCC333", "Quiet wallet"]]),
      counts: { signatures: 0, perWallet: {}, transactions: 0 },
      estimatedCredits: 0,
      budgets: BUDGETS,
    });
    expect(lines[0]).toBe("  Quiet wallet: 0 signatures");
  });

  it("adds the follow-up cap to the total and states it when followMaxCalls is given", () => {
    const lines = dryRunLines({
      labels: new Map([["AAA111", "Team wallet"]]),
      counts: { signatures: 2, perWallet: { AAA111: 2 }, transactions: 0 },
      estimatedCredits: 7000,
      budgets: BUDGETS,
      followMaxCalls: 300,
    });
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("Total: 2 unique signatures, ~7300 Helius credits");
    expect(lines[1]).toContain("0.73% of the 1000000 monthly allowance");
    expect(lines[2]).toBe("Follow-up tracing is capped at 300 calls per run.");
    expect(lines.at(-1)).toBe("Dry run: nothing written.");
  });
});

describe("overBudget with the follow-up cap", () => {
  it("counts the follow-up calls against the per-run warning", () => {
    expect(overBudget(99_700, BUDGETS, false, 300)).toBe(false);
    expect(overBudget(99_701, BUDGETS, false, 300)).toBe(true);
  });

  it("is still overridden by --force", () => {
    expect(overBudget(5_000_000, BUDGETS, true, 300)).toBe(false);
  });
});

describe("followLimits", () => {
  const DEFAULTS = {
    maxCalls: 300,
    maxTasks: 40,
    maxTx: 30,
    traceDepth: 1,
    saleDepth: 2,
    minTraceTokens: 100_000,
    traceDestinations: 25,
  };

  it("uses the defaults for an empty env", () => {
    expect(followLimits({})).toEqual(DEFAULTS);
  });

  it("reads every override from its env var", () => {
    expect(
      followLimits({
        WALLET_FLOWS_FOLLOW_MAX_CALLS: "500",
        WALLET_FLOWS_FOLLOW_MAX_TASKS: "10",
        WALLET_FLOWS_FOLLOW_MAX_TX: "5",
        WALLET_FLOWS_TRACE_DEPTH: "2",
        WALLET_FLOWS_SALE_DEPTH: "1",
        WALLET_FLOWS_TRACE_MIN_TOKENS: "250000",
        WALLET_FLOWS_TRACE_DESTINATIONS: "40",
      }),
    ).toEqual({
      maxCalls: 500,
      maxTasks: 10,
      maxTx: 5,
      traceDepth: 2,
      saleDepth: 1,
      minTraceTokens: 250_000,
      traceDestinations: 40,
    });
  });

  it("takes WALLET_FLOWS_TRACE_DEPTH=2 as depth 2 and clamps 9 to 2", () => {
    expect(followLimits({ WALLET_FLOWS_TRACE_DEPTH: "2" })).toMatchObject({ traceDepth: 2 });
    expect(followLimits({ WALLET_FLOWS_TRACE_DEPTH: "9" })).toMatchObject({ traceDepth: 2 });
  });

  it("caps the trace destination limit at 200", () => {
    expect(followLimits({ WALLET_FLOWS_TRACE_DESTINATIONS: "500" })).toMatchObject({ traceDestinations: 200 });
    expect(followLimits({ WALLET_FLOWS_TRACE_DESTINATIONS: "200" })).toMatchObject({ traceDestinations: 200 });
  });

  it("falls back to 25 destinations for values that are not a positive integer", () => {
    for (const value of ["abc", "0", "-3", "NaN"]) {
      expect(followLimits({ WALLET_FLOWS_TRACE_DESTINATIONS: value })).toMatchObject({ traceDestinations: 25 });
    }
  });

  it("clamps both depths to 1..2", () => {
    expect(followLimits({ WALLET_FLOWS_TRACE_DEPTH: "5", WALLET_FLOWS_SALE_DEPTH: "9" })).toMatchObject({
      traceDepth: 2,
      saleDepth: 2,
    });
    expect(followLimits({ WALLET_FLOWS_TRACE_DEPTH: "1", WALLET_FLOWS_SALE_DEPTH: "1" })).toMatchObject({
      traceDepth: 1,
      saleDepth: 1,
    });
  });

  it("falls back to the defaults for values that are not a positive finite number", () => {
    const garbage = ["abc", "", "-5", "0", "NaN", "Infinity", "0.5"];
    for (const value of garbage) {
      expect(followLimits({ WALLET_FLOWS_FOLLOW_MAX_CALLS: value })).toMatchObject({ maxCalls: 300 });
      expect(followLimits({ WALLET_FLOWS_TRACE_MIN_TOKENS: value })).toMatchObject({ minTraceTokens: 100_000 });
      expect(followLimits({ WALLET_FLOWS_SALE_DEPTH: value })).toMatchObject({ saleDepth: 2 });
    }
    expect(followLimits({ WALLET_FLOWS_TRACE_DEPTH: "garbage" })).toMatchObject({ traceDepth: 1 });
  });

  it("floors a fractional value to a whole number", () => {
    expect(followLimits({ WALLET_FLOWS_FOLLOW_MAX_TX: "7.9" })).toMatchObject({ maxTx: 7 });
  });
});

describe("attachSections", () => {
  const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const DEST = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const ZBCN_MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
  const NOW = 1_800_000_000;
  const registry = { knownWallets: [{ address: WALLET, label: "Team wallet" }] };
  const follow = { tasks: {}, hops: [] };

  const baseReport = {
    version: 1,
    generated: new Date(NOW * 1000).toISOString(),
    generator: "scripts/generate-wallet-flows-solana.js",
    project: "fixture",
    priceUsd: 0.01,
    priceSource: "fixture",
    chains: ["solana"],
    notes: [],
    distribution: { totalSupply: 1, counted: 1, classes: [{ key: "team", label: "Team", group: "team", tel: 1, share: 1 }] },
    telcoinTotals: {},
    knownWallets: [{ address: WALLET, label: "Team wallet" }],
    fundingLinks: [],
    botCluster: { label: "None tracked", chain: "solana", addresses: [], balance: 0, dexSales: {}, cexDeposits: {} },
    largeSellers: [],
  };

  const sales = [
    {
      sig: "5sigSaleA",
      wallet: WALLET,
      t: NOW - 3600,
      soldRaw: "2000000",
      legs: [{ holder: "wallet", source: "native", owner: WALLET, mint: SOL_MINT, raw: "500000000", decimals: 9, account: null }],
    },
  ];
  const events = [{ kind: "unlabelled", t: NOW - 7200, wallet: WALLET, dest: DEST, raw: "1000000000000", sig: "5sigTransferB", mint: ZBCN_MINT }];

  const salesJournal = buildSalesJournal({ sales, follow, registry, nowSec: NOW, zbcnDecimals: 6, solUsd: 150 });
  const unlabelledTrace = buildUnlabelledTrace({ events, follow, registry, nowSec: NOW, decimals: 6, priceUsd: 0.01 });

  it("returns the same report object when both sections are null", () => {
    const result = attachSections(baseReport, { salesJournal: null, unlabelledTrace: null });
    expect(result).toBe(baseReport);
    expect(Object.keys(result)).toEqual(Object.keys(baseReport));
  });

  it("adds only the sections that are non-null", () => {
    const result = attachSections(baseReport, { salesJournal, unlabelledTrace: null });
    expect(result.salesJournal).toBe(salesJournal);
    expect("unlabelledTrace" in result).toBe(false);
    expect(baseReport).not.toHaveProperty("salesJournal");
  });

  it("leaves the report with both sections valid under the base58 address check", () => {
    expect(salesJournal).not.toBeNull();
    expect(unlabelledTrace).not.toBeNull();
    const report = attachSections(baseReport, { salesJournal, unlabelledTrace });
    expect(Object.keys(report)).toEqual([...Object.keys(baseReport), "salesJournal", "unlabelledTrace"]);
    expect(validateWalletFlowsReport(report, { addressKind: "base58" })).toEqual([]);
  });
});
