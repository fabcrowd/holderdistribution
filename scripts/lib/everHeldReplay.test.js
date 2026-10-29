import { describe, it, expect } from "vitest";
import { extractHeldAddresses, advanceEverHeld } from "./everHeldReplay.js";

const snap = (wallets) => ({ chains: { solana: {} }, wallets });
const w = (address, bal) => ({ address, solana_balance: bal });

describe("extractHeldAddresses", () => {
  it("keeps positive-balance wallets not in the excluded or dropped sets", () => {
    const held = extractHeldAddresses(
      snap([w("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 5), w("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 0), w("0xcccccccccccccccccccccccccccccccccccccccc", 3), w("0xdddddddddddddddddddddddddddddddddddddddd", 2)]),
      new Set(["0xcccccccccccccccccccccccccccccccccccccccc"]),
      new Set(["0xdddddddddddddddddddddddddddddddddddddddd"]),
    );
    expect([...held]).toEqual(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("falls back to combined.holders[] for snapshots without wallets[]", () => {
    const held = extractHeldAddresses(
      { combined: { holders: [{ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", balance: 1 }, { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", balance: 0 }] } },
      new Set(),
    );
    expect([...held]).toEqual(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("returns an empty set for an empty snapshot", () => {
    expect(extractHeldAddresses({}, new Set()).size).toBe(0);
  });
});

describe("advanceEverHeld", () => {
  it("counts only unseen addresses as new and grows the set", () => {
    const ever = new Set(["a"]);
    expect(advanceEverHeld(ever, new Set(["a", "b", "c"]))).toEqual({ newHolders: 2, cumulativeHolders: 3 });
    expect(advanceEverHeld(ever, new Set(["a"]))).toEqual({ newHolders: 0, cumulativeHolders: 3 });
  });

  it("baseline day seeds the set and reports no newHolders instead of the whole base", () => {
    const ever = new Set();
    expect(advanceEverHeld(ever, new Set(["a", "b"]), { baseline: true })).toEqual({ newHolders: null, cumulativeHolders: 2 });
    expect(advanceEverHeld(ever, new Set(["a", "c"]))).toEqual({ newHolders: 1, cumulativeHolders: 3 });
  });

  it("non-baseline first day from an empty seed reports everyone as new (TEL-style behaviour kept)", () => {
    expect(advanceEverHeld(new Set(), new Set(["a"]))).toEqual({ newHolders: 1, cumulativeHolders: 1 });
  });
});
