import { describe, expect, it } from "vitest";
import { loadSolanaStakingPositions } from "./solanaStaking.js";

const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";

describe("loadSolanaStakingPositions", () => {
  it("returns null for a missing/empty feed", () => {
    expect(loadSolanaStakingPositions(null)).toBeNull();
    expect(loadSolanaStakingPositions({ positions: [] })).toBeNull();
  });

  it("builds a v3-shaped overlay keyed by exact-case base58", () => {
    const o = loadSolanaStakingPositions({
      chain: "solana",
      programId: "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv",
      name: "Zebec SuperApp staking",
      slot: 123,
      positions: [
        { staker: ALICE, amount: 2.5 },
        { staker: BOB, amount: 0.5 },
        { staker: "not-an-address", amount: 9 },
      ],
    });
    expect(o.chain).toBe("solana");
    expect([...o.positions.entries()]).toEqual([[ALICE, 2.5], [BOB, 0.5]]);
    expect(o.modules).toEqual([
      { address: "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv", name: "Zebec SuperApp staking", deployBlock: null, deployDate: null, lastBlock: 123 },
    ]);
  });
});
