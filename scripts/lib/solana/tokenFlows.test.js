import { describe, expect, it } from "vitest";
import { classifyFlow, mintDeltasByOwner } from "./tokenFlows.js";

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
