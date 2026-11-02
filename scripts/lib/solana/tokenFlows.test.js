import { describe, expect, it } from "vitest";
import { allMintDeltasByOwner, classifyFlow, mintDeltasByOwner, nativeSolDelta } from "./tokenFlows.js";

const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POOL = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const bal = (accountIndex, owner, amount, mint = MINT) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount) } });

describe("mintDeltasByOwner", () => {
  it("nets pre/post per owner for the mint only, keeping base58 case", () => {
    const tx = {
      meta: {
        preTokenBalances: [bal(1, ALICE, 1000), bal(2, POOL, 5000), bal(3, ALICE, 7, OTHER)],
        postTokenBalances: [bal(1, ALICE, 400), bal(2, POOL, 5600), bal(3, ALICE, 0, OTHER)],
      },
    };
    expect([...mintDeltasByOwner(tx, MINT).entries()]).toEqual([[ALICE, -600n], [POOL, 600n]]);
  });

  it("handles token accounts created in the tx (absent from pre)", () => {
    const tx = { meta: { preTokenBalances: [], postTokenBalances: [bal(4, ALICE, 50)] } };
    expect(mintDeltasByOwner(tx, MINT).get(ALICE)).toBe(50n);
  });

  it("handles token accounts closed in the tx (absent from post)", () => {
    const tx = { meta: { preTokenBalances: [bal(5, ALICE, 70)], postTokenBalances: [] } };
    expect(mintDeltasByOwner(tx, MINT).get(ALICE)).toBe(-70n);
  });

  it("returns an empty map for a failed tx", () => {
    expect(mintDeltasByOwner({ meta: { err: { InstructionError: [0, "x"] }, preTokenBalances: [], postTokenBalances: [] } }, MINT).size).toBe(0);
  });
});

describe("classifyFlow", () => {
  it("tags venue and side", () => {
    const d = new Map([[ALICE, -600n], [POOL, 600n]]);
    expect(classifyFlow(d, { cex: new Set(), dex: new Set([POOL]) })).toEqual([
      { owner: ALICE, raw: "600", side: "out", venue: null },
      { owner: POOL, raw: "600", side: "in", venue: "dex" },
    ]);
  });
});

const tokBal = (accountIndex, owner, amount, mint = MINT, decimals = 6) => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount: String(amount), decimals },
});
const POOL_OTHER_ACCT = "3rBbF3e4VUUK7vrbaWfKxWKJtHrSS5qmEhMfB2ZhG7NH";

describe("allMintDeltasByOwner", () => {
  it("agrees with mintDeltasByOwner per mint on a two-mint swap", () => {
    const tx = {
      meta: {
        preTokenBalances: [bal(1, ALICE, 1000), bal(2, POOL, 5000), bal(3, ALICE, 7, OTHER), bal(4, POOL, 100, OTHER)],
        postTokenBalances: [bal(1, ALICE, 400), bal(2, POOL, 5600), bal(3, ALICE, 0, OTHER), bal(4, POOL, 107, OTHER)],
      },
    };
    const all = allMintDeltasByOwner(tx);
    for (const mint of [MINT, OTHER]) {
      const perMint = new Map();
      for (const [owner, byMint] of all) if (byMint.has(mint)) perMint.set(owner, byMint.get(mint).raw);
      expect(perMint).toEqual(mintDeltasByOwner(tx, mint));
    }
  });

  it("gives a negative delta for an account present only in pre", () => {
    const tx = { meta: { preTokenBalances: [tokBal(5, ALICE, 70)], postTokenBalances: [] } };
    expect(allMintDeltasByOwner(tx).get(ALICE).get(MINT).raw).toBe(-70n);
  });

  it("returns an empty map for a failed tx", () => {
    const tx = { meta: { err: { InstructionError: [0, "x"] }, preTokenBalances: [tokBal(1, ALICE, 10)], postTokenBalances: [tokBal(1, ALICE, 20)] } };
    expect(allMintDeltasByOwner(tx).size).toBe(0);
  });

  it("drops zero deltas, including owners left with no entries", () => {
    const tx = {
      meta: {
        preTokenBalances: [tokBal(1, ALICE, 10), tokBal(2, ALICE, 5), tokBal(3, POOL, 0)],
        postTokenBalances: [tokBal(1, ALICE, 10), tokBal(2, ALICE, 5), tokBal(3, POOL, 0)],
      },
    };
    expect(allMintDeltasByOwner(tx).size).toBe(0);
  });

  it("keeps non-zero entries alongside dropped zero ones", () => {
    const tx = {
      meta: {
        preTokenBalances: [tokBal(1, ALICE, 10, OTHER), tokBal(2, ALICE, 1)],
        postTokenBalances: [tokBal(1, ALICE, 10, OTHER), tokBal(2, ALICE, 4)],
      },
    };
    const all = allMintDeltasByOwner(tx);
    expect([...all.keys()]).toEqual([ALICE]);
    expect([...all.get(ALICE).keys()]).toEqual([MINT]);
    expect(all.get(ALICE).get(MINT).raw).toBe(3n);
  });

  it("returns the token account for string and {pubkey} account keys, null when accountKeys is missing", () => {
    const withKeys = {
      transaction: { message: { accountKeys: [ALICE, { pubkey: POOL_OTHER_ACCT }] } },
      meta: { preTokenBalances: [], postTokenBalances: [tokBal(0, ALICE, 5), tokBal(1, POOL, 9)] },
    };
    const all = allMintDeltasByOwner(withKeys);
    expect(all.get(ALICE).get(MINT)).toMatchObject({ raw: 5n, decimals: 6, account: ALICE });
    expect(all.get(POOL).get(MINT).account).toBe(POOL_OTHER_ACCT);

    const noKeys = { meta: { preTokenBalances: [], postTokenBalances: [tokBal(0, ALICE, 5)] } };
    expect(allMintDeltasByOwner(noKeys).get(ALICE).get(MINT).account).toBeNull();
  });

  it("keeps base58 owners that differ only in case as separate keys", () => {
    const lower = ALICE.toLowerCase();
    const tx = { meta: { preTokenBalances: [], postTokenBalances: [tokBal(1, ALICE, 10), tokBal(2, lower, 20)] } };
    const all = allMintDeltasByOwner(tx);
    expect(all.size).toBe(2);
    expect(all.get(ALICE).get(MINT).raw).toBe(10n);
    expect(all.get(lower).get(MINT).raw).toBe(20n);
  });
});

describe("nativeSolDelta", () => {
  const txWithSol = {
    transaction: { message: { accountKeys: [ALICE, { pubkey: POOL }] } },
    meta: { fee: 100, preBalances: [1000, 500], postBalances: [800, 700] },
  };

  it("adds the fee back for the payer at index 0 only", () => {
    expect(nativeSolDelta(txWithSol, ALICE)).toBe(-100n);
    expect(nativeSolDelta(txWithSol, POOL)).toBe(200n);
  });

  it("returns 0n for an absent owner or missing meta", () => {
    expect(nativeSolDelta(txWithSol, OTHER)).toBe(0n);
    expect(nativeSolDelta({ transaction: txWithSol.transaction }, ALICE)).toBe(0n);
  });
});
