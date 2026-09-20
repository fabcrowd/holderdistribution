import { describe, expect, it } from "vitest";
import { classifySnapshot, stakedAmountsByAddress } from "./phantomStakers.js";

const addr = (n) => `0x${String(n).repeat(40).slice(0, 40)}`;
const A = addr(1);
const B = addr(2);
const C = addr(3);
const D = addr(4);

const snapshotOf = (entries) => ({
  wallets: entries.map(([address, polygon_balance]) => ({ address, polygon_balance })),
});

describe("stakedAmountsByAddress", () => {
  it("reads fundingWallet entries and lowercases addresses", () => {
    const map = stakedAmountsByAddress({
      wallets: [{ fundingWallet: A.toUpperCase().replace("0X", "0x"), stakedAmount: 500 }],
    });
    expect(map.get(A)).toBe(500);
  });

  it("skips malformed addresses and non-finite amounts", () => {
    const map = stakedAmountsByAddress({
      wallets: [
        { fundingWallet: "not-an-address", stakedAmount: 1 },
        { fundingWallet: A, stakedAmount: "oops" },
        { fundingWallet: B, stakedAmount: 7 },
      ],
    });
    expect(map.size).toBe(1);
    expect(map.get(B)).toBe(7);
  });
});

describe("classifySnapshot", () => {
  it("flags a dropped wallet whose polygon balance equals its attributed stake", () => {
    // The production shape: the pre-2026-08-07 netting invented a staker, and
    // pull-holders-rpc.js merged that amount in as the wallet's whole balance.
    const { phantoms, ambiguous } = classifySnapshot(
      snapshotOf([[A, 100_000_000]]),
      new Map([[A, 100_000_000]]),
      new Map(),
    );
    expect([...phantoms]).toEqual([A]);
    expect(ambiguous).toBe(0);
  });

  it("keeps a dropped wallet whose balance exceeds its stake", () => {
    // A real Polygon holder who also staked: balance is holdings + stake, so it
    // cannot land exactly on the stake. Removing these would undercount.
    const { phantoms, ambiguous } = classifySnapshot(
      snapshotOf([[A, 150_000]]),
      new Map([[A, 100_000]]),
      new Map(),
    );
    expect(phantoms.size).toBe(0);
    expect(ambiguous).toBe(1);
  });

  it("never flags a wallet still present in today's attribution", () => {
    const { phantoms, retained } = classifySnapshot(
      snapshotOf([[A, 100_000]]),
      new Map([[A, 100_000]]),
      new Map([[A, 100_000]]),
    );
    expect(phantoms.size).toBe(0);
    expect(retained).toBe(1);
  });

  it("ignores attributed wallets absent from the snapshot's polygon balances", () => {
    const { phantoms, ambiguous } = classifySnapshot(
      snapshotOf([[B, 5]]),
      new Map([[A, 100_000]]),
      new Map(),
    );
    expect(phantoms.size).toBe(0);
    expect(ambiguous).toBe(0);
  });

  it("tolerates sub-cent float noise from the raw/human conversion", () => {
    const { phantoms } = classifySnapshot(
      snapshotOf([[A, 69_696_969.69]]),
      new Map([[A, 69_696_969.691]]),
      new Map(),
    );
    expect([...phantoms]).toEqual([A]);
  });

  it("separates phantom, ambiguous, and retained wallets in one pass", () => {
    const { phantoms, ambiguous, retained } = classifySnapshot(
      snapshotOf([
        [A, 1_000],
        [B, 2_500],
        [C, 400],
      ]),
      new Map([
        [A, 1_000], // phantom: balance == stake, dropped from today
        [B, 1_000], // ambiguous: real holdings on top of a stake
        [C, 400], // retained: still a staker today
        [D, 900], // not in the snapshot at all
      ]),
      new Map([[C, 400]]),
    );
    expect([...phantoms]).toEqual([A]);
    expect(ambiguous).toBe(1);
    expect(retained).toBe(1);
  });
});
