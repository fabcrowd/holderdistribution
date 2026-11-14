import { describe, expect, it } from "vitest";
import { canonicalOwner, classifyHederaTx } from "./flowClassify.js";

const roles = { cex: new Map([["0.0.100001", "Alpha"], ["0.0.100002", "Alpha"], ["0.0.200001", "Beta"]]) };
const USER = "0.0.5000001";
const OTHER = "0.0.5000002";
const SINK = "0.0.802";
const FEE = 150000;

/** One mirror record; `legs` are the non-fee legs [account, amount]; the payer's leg must already include the fee. */
const record = ({ payer = USER, legs, fee = FEE, result = "SUCCESS", ts = "1794300000.000000001", extra = {} }) => ({
  consensus_timestamp: ts,
  transaction_id: `${payer}-1794299990-000000001`,
  charged_tx_fee: fee,
  result,
  nonce: 0,
  staking_reward_transfers: [],
  transfers: [...legs.map(([account, amount]) => ({ account, amount })), ...(fee > 0 ? [{ account: SINK, amount: fee }] : [])],
  ...extra,
});

describe("classifyHederaTx", () => {
  it("a deposit is a cexIn of the exchange, the sender the counterparty, the fee excluded", () => {
    const tx = record({ legs: [[USER, -(1000 + FEE)], ["0.0.100001", 1000]] });
    expect(classifyHederaTx(tx, roles).events).toEqual([{ kind: "cexIn", venue: "Alpha", counterparty: USER, raw: "1000" }]);
  });

  it("a withdrawal is a cexOut: the exchange pays the fee as payer, and the fee is added back", () => {
    const tx = record({ payer: "0.0.100001", legs: [["0.0.100001", -(2500 + FEE)], [USER, 2500]] });
    const { events, audit } = classifyHederaTx(tx, roles);
    expect(events).toEqual([{ kind: "cexOut", venue: "Alpha", counterparty: USER, raw: "2500" }]);
    expect(audit).toMatchObject({ fee: BigInt(FEE), feeMatched: true });
  });

  it("a transfer between two accounts of one exchange is internal, never a flow", () => {
    const tx = record({ legs: [["0.0.100001", -(700 + FEE)], ["0.0.100002", 700]], payer: "0.0.100001" });
    expect(classifyHederaTx(tx, roles).events).toEqual([{ kind: "internal", venue: "Alpha", counterparty: "0.0.100001", raw: "700" }]);
  });

  it("a transfer between two different exchanges is a withdrawal for one and a deposit for the other", () => {
    const tx = record({ legs: [["0.0.100001", -(900 + FEE)], ["0.0.200001", 900]], payer: "0.0.100001" });
    expect(classifyHederaTx(tx, roles).events).toEqual([
      { kind: "cexOut", venue: "Alpha", counterparty: "0.0.200001", raw: "900" },
      { kind: "cexIn", venue: "Beta", counterparty: "0.0.100001", raw: "900" },
    ]);
  });

  it("a failed record moves only its fee: no flow, whatever the result text", () => {
    for (const result of ["INVALID_ACCOUNT_ID", "DUPLICATE_TRANSACTION", "INSUFFICIENT_PAYER_BALANCE"]) {
      const tx = record({ payer: "0.0.100001", legs: [["0.0.100001", -FEE]], result });
      const out = classifyHederaTx(tx, roles);
      expect(out.events).toEqual([]);
      expect(out.audit.feeMatched).toBe(true);
    }
  });

  it("a child record (nonce > 0, e.g. account creation paid by the exchange) is its own fee-only row", () => {
    const tx = record({ payer: "0.0.100001", legs: [["0.0.100001", -76_000_000]], fee: 76_000_000, extra: { nonce: 1, parent_consensus_timestamp: "1794299999.999999999" } });
    expect(classifyHederaTx(tx, roles).events).toEqual([]);
  });

  it("token transfers are ignored: a record with only a fee leg for the exchange has no HBAR flow", () => {
    const tx = record({ payer: "0.0.100001", legs: [["0.0.100001", -FEE]], extra: { token_transfers: [{ token_id: "0.0.456858", account: "0.0.100001", amount: -5 }] } });
    expect(classifyHederaTx(tx, roles).events).toEqual([]);
  });

  it("a staking reward netted into the sender's leg is removed with the 0.0.800 debit, so the deposit is the real amount", () => {
    const reward = 4000;
    const tx = record({
      legs: [[USER, -(1000 + FEE) + reward], ["0.0.100001", 1000], ["0.0.800", -reward]],
      extra: { staking_reward_transfers: [{ account: USER, amount: reward }] },
    });
    const { events, audit } = classifyHederaTx(tx, roles);
    expect(events).toEqual([{ kind: "cexIn", venue: "Alpha", counterparty: USER, raw: "1000" }]);
    expect(audit).toMatchObject({ reward: BigInt(reward), rewardResidual: 0n });
  });

  it("a single reward is the exact 0.0.800 debit even when the listed amount is a tinybar off", () => {
    const tx = record({
      legs: [[USER, -(1000 + FEE) + 4000], ["0.0.100001", 1000], ["0.0.800", -4000]],
      extra: { staking_reward_transfers: [{ account: USER, amount: 4001 }] },
    });
    const { events, audit } = classifyHederaTx(tx, roles);
    expect(events).toEqual([{ kind: "cexIn", venue: "Alpha", counterparty: USER, raw: "1000" }]);
    expect(audit.rewardResidual).toBe(0n);
  });

  it("a reward paid to an exchange account is not a deposit", () => {
    const tx = record({
      payer: "0.0.100001",
      legs: [["0.0.100001", -(300 + FEE) + 50], [USER, 300], ["0.0.800", -50]],
      extra: { staking_reward_transfers: [{ account: "0.0.100001", amount: 50 }] },
    });
    expect(classifyHederaTx(tx, roles).events).toEqual([{ kind: "cexOut", venue: "Alpha", counterparty: USER, raw: "300" }]);
  });

  it("a fee share credited to 0.0.800 inside its net-negative debit is added back to the single reward", () => {
    const reward = 50;
    const share = 20; // older eras: 0.0.800 also received part of the fee
    const tx = record({
      payer: "0.0.100001",
      legs: [["0.0.100001", -(300 + FEE) + reward], [USER, 300], ["0.0.800", share - reward]],
      fee: FEE,
      extra: { staking_reward_transfers: [{ account: "0.0.100001", amount: reward }] },
    });
    tx.transfers = tx.transfers.map((leg) => (leg.account === SINK ? { account: "0.0.98", amount: FEE - share } : leg));
    const { events, audit } = classifyHederaTx(tx, roles);
    expect(events).toEqual([{ kind: "cexOut", venue: "Alpha", counterparty: USER, raw: "300" }]);
    expect(audit).toMatchObject({ reward: BigInt(reward), rewardPoolFeeShare: BigInt(share), rewardResidual: 0n });
  });

  it("a record that touches no exchange account yields nothing", () => {
    expect(classifyHederaTx(record({ legs: [[USER, -(5 + FEE)], [OTHER, 5]] }), roles).events).toEqual([]);
  });

  it("flags a fee that cannot be matched to the fee sink instead of guessing", () => {
    const tx = record({ legs: [[USER, -(1000 + FEE)], ["0.0.100001", 1000]], extra: { charged_tx_fee: FEE + 7 } });
    expect(classifyHederaTx(tx, roles).audit.feeMatched).toBe(false);
  });

  it("rejects a record with no transfers array or an unreadable leg", () => {
    expect(() => classifyHederaTx({ consensus_timestamp: "1.1" }, roles)).toThrow(/no transfers/);
    expect(() => classifyHederaTx({ consensus_timestamp: "1.1", transfers: [{ account: "bad", amount: 1 }] }, roles)).toThrow(/unreadable/);
  });

  it("conserves amounts: per-exchange cexIn minus cexOut equals the exchange accounts' fee-free net", () => {
    const tx = record({ payer: "0.0.100001", legs: [["0.0.100001", -(500 + 200 + FEE)], [USER, 500], ["0.0.200001", 200]] });
    const net = Object.fromEntries([["Alpha", 0n], ["Beta", 0n]]);
    for (const e of classifyHederaTx(tx, roles).events) net[e.venue] += (e.kind === "cexIn" ? 1n : -1n) * BigInt(e.raw);
    expect(net).toEqual({ Alpha: -700n, Beta: 200n });
  });
});

describe("canonicalOwner", () => {
  it("is the first exchange account in config order that has an HBAR leg", () => {
    const tx = record({ legs: [["0.0.200001", 5], ["0.0.100002", 5], [USER, -(10 + FEE)]] });
    expect(canonicalOwner(tx, ["0.0.100001", "0.0.100002", "0.0.200001"])).toBe("0.0.100002");
    expect(canonicalOwner(record({ legs: [[USER, -(1 + FEE)], [OTHER, 1]] }), ["0.0.100001"])).toBeNull();
  });

  it("is the lowest id with a leg whatever the config order, compared numerically", () => {
    const tx = record({ legs: [["0.0.200001", 5], ["0.0.100002", 5], ["0.0.99999", 5], [USER, -(15 + FEE)]] });
    const ids = ["0.0.200001", "0.0.100002", "0.0.99999", "0.0.100001"];
    expect(canonicalOwner(tx, ids)).toBe("0.0.99999");
    expect(canonicalOwner(tx, [...ids].reverse())).toBe("0.0.99999");
    expect(canonicalOwner(tx, ["0.0.200001", "0.0.100002"])).toBe("0.0.100002");
  });
});
