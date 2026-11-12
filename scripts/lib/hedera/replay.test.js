import { describe, expect, it } from "vitest";
import { applyHbarTransfers } from "./replay.js";

const HBAR = 100_000_000n;

describe("applyHbarTransfers", () => {
  it("moves HBAR, including a fee, and leaves the input map unchanged", () => {
    const balances = new Map([
      ["0.0.1", 50_000_000n],
      ["0.0.2", HBAR],
    ]);
    const next = applyHbarTransfers(balances, [
      {
        result: "SUCCESS",
        consensus_timestamp: "1794165041.000000001",
        transfers: [
          { account: "0.0.2", amount: "-60000001" },
          { account: "0.0.1", amount: "60000000" },
          { account: "0.0.98", amount: "1" },
        ],
      },
    ]);
    expect(next.get("0.0.1")).toBe(110_000_000n);
    expect(next.get("0.0.2")).toBe(39_999_999n);
    expect(next.get("0.0.98")).toBe(1n);
    expect(balances.get("0.0.1")).toBe(50_000_000n);
  });

  it("uses the live mirror's fee split once", () => {
    const next = applyHbarTransfers(new Map([["0.0.3229", 1_000_000_000n]]), [
      {
        result: "SUCCESS",
        consensus_timestamp: "1794188699.000000001",
        transfers: [
          { account: "0.0.802", amount: 149607 },
          { account: "0.0.3229", amount: -149608 },
          { account: "0.0.3230", amount: 1, is_approval: false },
        ],
        staking_reward_transfers: [],
      },
    ]);
    expect(next.get("0.0.3229")).toBe(1_000_000_000n - 149608n);
    expect(next.get("0.0.802")).toBe(149607n);
    expect(next.get("0.0.3230")).toBe(1n);
  });

  it("does not apply a staking reward twice when the mirror also lists it in transfers", () => {
    const next = applyHbarTransfers(new Map([["0.0.800", 1_000n]]), [
      {
        result: "SUCCESS",
        consensus_timestamp: "1794165042.000000000",
        transfers: [
          { account: "0.0.800", amount: "-5" },
          { account: "0.0.5", amount: "5" },
        ],
        staking_reward_transfers: [{ account: "0.0.5", amount: "5" }],
      },
    ]);
    expect(next.get("0.0.5")).toBe(5n);
    expect(next.get("0.0.800")).toBe(995n);
  });

  it("accepts the live shape: a reward netted with the fee into one leg, funded by 0.0.800", () => {
    // Mainnet 1794439241.190204231 (ConsensusSubmitMessage): reward 673,737,900 minus fee 257,573 in one leg.
    const next = applyHbarTransfers(new Map([["0.0.10441852", 0n], ["0.0.800", 1_000_000_000n]]), [
      {
        result: "SUCCESS",
        consensus_timestamp: "1794439241.190204231",
        transfers: [
          { account: "0.0.800", amount: -673737900 },
          { account: "0.0.802", amount: 257573 },
          { account: "0.0.10441852", amount: 673480327 },
        ],
        staking_reward_transfers: [{ account: "0.0.10441852", amount: 673737900 }],
      },
    ]);
    expect(next.get("0.0.10441852")).toBe(673_480_327n);
    expect(next.get("0.0.800")).toBe(1_000_000_000n - 673_737_900n);
  });

  it("never applies staking_reward_transfers, which can be a tinybar off the 0.0.800 debit", () => {
    // Mainnet 1794439266.363124104: reward 16,111,538,460, 0.0.800 debited 16,111,538,459; transfers balance.
    const next = applyHbarTransfers(new Map([["0.0.2002221", 0n], ["0.0.800", 20_000_000_000n]]), [
      {
        result: "SUCCESS",
        consensus_timestamp: "1794439266.363124104",
        transfers: [
          { account: "0.0.800", amount: -16111538459 },
          { account: "0.0.802", amount: 151513 },
          { account: "0.0.2002221", amount: 16111386946 },
        ],
        staking_reward_transfers: [{ account: "0.0.2002221", amount: 16111538460 }],
      },
    ]);
    expect(next.get("0.0.2002221")).toBe(16_111_386_946n);
    expect(next.get("0.0.800")).toBe(20_000_000_000n - 16_111_538_459n);
  });

  it("charges a failed transaction's fee (its only legs), and rejects a leg that does not balance", () => {
    const balances = new Map([["0.0.2", 10n]]);
    const failed = { result: "WRONG_NONCE", consensus_timestamp: "1.0", transfers: [{ account: "0.0.2", amount: "-3" }, { account: "0.0.98", amount: "3" }] };
    const after = applyHbarTransfers(balances, [failed]);
    expect(after.get("0.0.2")).toBe(7n);
    expect(after.get("0.0.98")).toBe(3n);
    expect(applyHbarTransfers(balances, [{ result: "INSUFFICIENT_TOKEN_BALANCE", consensus_timestamp: "1.5", transfers: [] }]).get("0.0.2")).toBe(10n);
    const broken = { result: "SUCCESS", consensus_timestamp: "2.0", transfers: [{ account: "0.0.2", amount: "-10" }] };
    expect(() => applyHbarTransfers(balances, [broken])).toThrow(/sum to -10/);
  });

  it("keeps an amount above 2^53 exact", () => {
    const next = applyHbarTransfers(new Map(), [
      {
        result: "SUCCESS",
        consensus_timestamp: "3.0",
        transfers: [
          { account: "0.0.2", amount: "-5000000000000000001" },
          { account: "0.0.3", amount: "5000000000000000001" },
        ],
      },
    ]);
    expect(next.get("0.0.3")).toBe(5_000_000_000_000_000_001n);
  });
});
