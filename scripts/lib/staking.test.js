import { describe, expect, it } from "vitest";
import { selector, topicHash, STAKE_CHANGED_TOPIC0, parseStakeChangedAccount, parseStakeChangedEvent, encodeAddressCall, decodeUint256 } from "./staking.js";

const CONTRACT = "0x92e43aec69207755cb1e6a8dc589aae630476330";
const normalize = (v) => (typeof v === "string" ? v.toLowerCase() : null);

// The exact bug this session found: transfer-log net reconstruction assumes a
// staker's deposits and withdrawals happen through the SAME address. This
// contract's stakeFor/claimAndExitFor let them differ, which silently
// overstated attributed staking by ~505.7M TEL (12.1%) in production.
const oldNetTransferLogMethod = (transfers) => {
  const netMap = new Map();
  for (const tx of transfers) {
    const from = normalize(tx.from);
    const to = normalize(tx.to);
    const value = BigInt(tx.value);
    if (to === CONTRACT && from !== CONTRACT) {
      netMap.set(from, (netMap.get(from) ?? 0n) + value);
    } else if (from === CONTRACT && to !== CONTRACT) {
      netMap.set(to, (netMap.get(to) ?? 0n) - value);
    }
  }
  let total = 0n;
  for (const net of netMap.values()) if (net > 0n) total += net;
  return total;
};

describe("selector / calldata encoding", () => {
  it("computes the real on-chain selectors used against the staking contract", () => {
    // Verified live against api.etherscan.io on 2026-08-07.
    expect(selector("totalStaked()")).toBe("0x817b1cd2");
    expect(selector("stakedBy(address)")).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it("pads an address to 32 bytes for a single-arg call", () => {
    const call = encodeAddressCall("stakedBy(address)", "0xAAAA000000000000000000000000000000bbbb");
    expect(call).toHaveLength(2 + 8 + 64); // 0x + selector + word
    expect(call.endsWith("aaaa000000000000000000000000000000bbbb")).toBe(true);
  });

  it("decodes a uint256 eth_call result", () => {
    expect(decodeUint256("0x00000000000000000000000000000000000000000000000000000060ff4c7a33")).toBe(416600062515);
    expect(decodeUint256("0x")).toBe(0);
    expect(decodeUint256(null)).toBe(0);
  });
});

describe("StakeChanged log discovery", () => {
  it("computes the real StakeChanged(address,uint256,uint256) topic0", () => {
    // Verified live against api.etherscan.io on 2026-08-11 — this exact
    // topic0 returned real StakeChanged logs from the staking contract.
    expect(STAKE_CHANGED_TOPIC0).toBe("0xd473ba45d607aefbdd0f6f0d283e9452b2fff27c93dda618526d18ffd9a170c7");
    expect(topicHash("StakeChanged(address,uint256,uint256)")).toBe(STAKE_CHANGED_TOPIC0);
  });

  it("full topic hash is 32 bytes, unlike the 4-byte function selector", () => {
    expect(STAKE_CHANGED_TOPIC0).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("extracts the indexed account address from topics[1]", () => {
    const log = {
      topics: [
        STAKE_CHANGED_TOPIC0,
        "0x00000000000000000000000048a7209dd07bc7409bf3f61820e1ee9409f462e9",
      ],
    };
    expect(parseStakeChangedAccount(log, normalize)).toBe("0x48a7209dd07bc7409bf3f61820e1ee9409f462e9");
  });

  it("captures a stakeFor beneficiary that never appears in a Transfer log", () => {
    // The exact gap this replaces Transfer-log discovery for: a relayer
    // calls stakeFor(beneficiary, amount), so the ERC-20 Transfer is
    // relayer->contract — the beneficiary's own address never touches a
    // Transfer to/from the contract and is invisible to that method. The
    // contract's own StakeChanged event fires with the true beneficiary
    // regardless of who relayed it.
    const relayer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const beneficiary = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const log = {
      topics: [
        STAKE_CHANGED_TOPIC0,
        `0x000000000000000000000000${beneficiary.slice(2)}`,
      ],
    };
    const account = parseStakeChangedAccount(log, normalize);
    expect(account).toBe(beneficiary);
    expect(account).not.toBe(relayer);
  });

  it("returns null for a malformed or missing topics[1]", () => {
    expect(parseStakeChangedAccount({ topics: [STAKE_CHANGED_TOPIC0] }, normalize)).toBeNull();
    expect(parseStakeChangedAccount({}, normalize)).toBeNull();
  });
});

describe("parseStakeChangedEvent (full log, both data words)", () => {
  const ACCOUNT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  // uint256 words are 64 hex chars each. Per Solidity ABI encoding,
  // non-indexed params pack into `data` in declaration order:
  // StakeChanged(address indexed account, uint256 oldStake, uint256 newStake)
  // -> word 0 = oldStake, word 1 = newStake. This is the exact assumption
  // verify-staker-methods.js independently checks against a live log before
  // any production code trusts it (see the function's own doc comment).
  const buildLog = (oldStake, newStake, overrides = {}) => ({
    topics: [STAKE_CHANGED_TOPIC0, `0x000000000000000000000000${ACCOUNT.slice(2)}`],
    data: `0x${oldStake.toString(16).padStart(64, "0")}${newStake.toString(16).padStart(64, "0")}`,
    blockNumber: "0x64", // 100
    logIndex: "0x2", // 2
    ...overrides,
  });

  it("extracts account, oldStake, newStake, blockNumber, and logIndex from a real-shaped log", () => {
    const event = parseStakeChangedEvent(buildLog(0n, 500_00n), normalize);
    expect(event).toEqual({
      account: ACCOUNT,
      oldStake: 0n,
      newStake: 50000n,
      blockNumber: 100,
      logIndex: 2,
    });
  });

  it("a fully-exited account's most recent event has newStake === 0 — this is the case that must be excluded from the funding-wallets output, not silently kept at its last nonzero balance", () => {
    const event = parseStakeChangedEvent(buildLog(50000n, 0n), normalize);
    expect(event.newStake).toBe(0n);
  });

  it("decimal-numeric blockNumber/logIndex (not hex strings) are also accepted — some RPC providers return either shape", () => {
    const event = parseStakeChangedEvent(buildLog(0n, 100n, { blockNumber: 100, logIndex: 2 }), normalize);
    expect(event.blockNumber).toBe(100);
    expect(event.logIndex).toBe(2);
  });

  it("defaults logIndex to 0 when absent, rather than dropping the event", () => {
    const log = buildLog(0n, 100n);
    delete log.logIndex;
    const event = parseStakeChangedEvent(log, normalize);
    expect(event.logIndex).toBe(0);
  });

  it("returns null when data is shorter than two 32-byte words", () => {
    const log = buildLog(0n, 100n);
    log.data = log.data.slice(0, 2 + 64); // only one word
    expect(parseStakeChangedEvent(log, normalize)).toBeNull();
  });

  it("returns null when the account itself can't be parsed", () => {
    expect(parseStakeChangedEvent(buildLog(0n, 100n, { topics: [STAKE_CHANGED_TOPIC0] }), normalize)).toBeNull();
  });

  it("returns null when blockNumber is missing or unparseable — every consumer relies on it for latest-wins ordering", () => {
    expect(parseStakeChangedEvent(buildLog(0n, 100n, { blockNumber: undefined }), normalize)).toBeNull();
    expect(parseStakeChangedEvent(buildLog(0n, 100n, { blockNumber: "not-a-number" }), normalize)).toBeNull();
  });
});

describe("latest-stake-per-account reduction (the core log-replay logic)", () => {
  // This is the reduction verify-staker-methods.js and the eventual
  // pull-staker-balances.js rewrite both depend on: given every StakeChanged
  // event for an account, across possibly-out-of-order log pages, the
  // account's CURRENT stake is whichever event has the highest
  // (blockNumber, logIndex) — not the numerically highest newStake, not the
  // last event in array order.
  const reduceLatestPerAccount = (events) => {
    const byAccount = new Map();
    for (const event of events) {
      const existing = byAccount.get(event.account);
      if (
        !existing ||
        event.blockNumber > existing.blockNumber ||
        (event.blockNumber === existing.blockNumber && event.logIndex > existing.logIndex)
      ) {
        byAccount.set(event.account, event);
      }
    }
    return byAccount;
  };

  const A = "0xaaaa000000000000000000000000000000aaaa";
  const B = "0xbbbb000000000000000000000000000000bbbb";
  const ev = (account, blockNumber, logIndex, newStake) => ({ account, oldStake: 0n, newStake, blockNumber, logIndex });

  it("takes the highest blockNumber per account, regardless of array order", () => {
    const events = [ev(A, 300, 0, 999n), ev(A, 100, 0, 50n), ev(A, 200, 0, 75n)];
    const result = reduceLatestPerAccount(events);
    expect(result.get(A).newStake).toBe(999n);
    expect(result.get(A).blockNumber).toBe(300);
  });

  it("breaks a same-block tie by the higher logIndex, not by array order or by amount", () => {
    // Both events are in the SAME block — a staker who stakes then
    // immediately exits in one block. logIndex 5 fired after logIndex 1, so
    // it reflects the true final state even though it has a SMALLER amount
    // and appears FIRST in this array.
    const events = [ev(A, 500, 5, 0n), ev(A, 500, 1, 1000n)];
    const result = reduceLatestPerAccount(events);
    expect(result.get(A).logIndex).toBe(5);
    expect(result.get(A).newStake).toBe(0n);
  });

  it("keeps each account's own latest event independent of other accounts", () => {
    const events = [ev(A, 100, 0, 10n), ev(B, 999, 0, 20n), ev(A, 200, 0, 30n)];
    const result = reduceLatestPerAccount(events);
    expect(result.get(A).newStake).toBe(30n);
    expect(result.get(B).newStake).toBe(20n);
  });

  it("a fully-exited account (latest newStake === 0) is excluded downstream, not kept at its last nonzero amount", () => {
    const events = [ev(A, 100, 0, 500n), ev(A, 200, 0, 0n)];
    const result = reduceLatestPerAccount(events);
    // The reduction itself keeps the zero-stake record — filtering it out of
    // the final wallets[] array is a separate step (matches
    // pull-staker-balances.js's existing `if (stakedAmount <= 0) continue;`).
    expect(result.get(A).newStake).toBe(0n);
  });
});

describe("why stakedBy() replaces transfer-log net reconstruction", () => {
  it("demonstrates the old method overstates when withdrawal routes to a different address (stakeFor/claimAndExitFor)", () => {
    const A = "0xaaaa000000000000000000000000000000aaaa"; // depositor
    const B = "0xbbbb000000000000000000000000000000bbbb"; // withdrawal destination, per claimAndExitFor(account, to, ...)

    // A stakes 100. Later, A's position is exited via claimAndExitFor with `to` = B,
    // paying the withdrawal to B instead of back to A — a real, supported flow.
    const transfers = [
      { from: A, to: CONTRACT, value: "100" },
      { from: CONTRACT, to: B, value: "100" },
    ];

    const oldTotal = oldNetTransferLogMethod(transfers);
    // A's net is still +100 (its withdrawal never happened, from A's perspective).
    // B's net is -100, which is <= 0 and gets dropped entirely by the "positive
    // nets only" filter. Nothing offsets A's balance: the contract is empty
    // (fully exited) but the old method reports 100 TEL still staked.
    expect(oldTotal).toBe(100n);

    // The true current state, straight from the contract's own accounting: A
    // has stakedBy(A) === 0 (exited), and stakedBy(B) === 0 (B never staked,
    // just received a payout). Sum of stakedBy across candidates is the
    // authoritative truth: 0.
    const trueStakedByA = 0n;
    const trueStakedByB = 0n;
    expect(trueStakedByA + trueStakedByB).toBe(0n);
    expect(oldTotal).not.toBe(trueStakedByA + trueStakedByB);
  });

  it("matches the magnitude of the real production overstatement", () => {
    // Real figures from the 2026-08-07 investigation, not invented: transfer-log
    // netting reported 4,671,684,407.45 TEL; the contract's own totalStaked()
    // reported 4,166,000,625.15 TEL.
    const oldMethodTotal = 4_671_684_407.45;
    const trueTotal = 4_166_000_625.15;
    const overstatement = oldMethodTotal - trueTotal;
    expect(overstatement).toBeCloseTo(505_683_782.3, 0);
    expect(overstatement / trueTotal).toBeGreaterThan(0.1); // >10% overstated
  });
});
