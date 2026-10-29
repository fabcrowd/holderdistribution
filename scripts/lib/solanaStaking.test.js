import { describe, expect, it } from "vitest";
import { loadSolanaStakingPositions, applySolanaStakingSnapshot, attributeSolanaStakingBalances } from "./solanaStaking.js";
import { attributeCustodyStaking } from "./stakingCustody.js";

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

const VAULT_A = "5Fe1JVUkaHVEAQ8sZ71xmQdyVahwfeuP4s9TGZ9mf8vk";
const VAULT_B = "HJqK7re4GDSm4roQQS2iSLt5p7Gyb9MHBy9dHJw9obUp";
const REWARD = "7oKEHLFXbya57ZixovrDStQCxWpVJmisHszLSSiZXPdG";
const CEX = "22Wnk8PwyWZV7BfkZGJEKT9jGGdtvu7xY6EXeRh7zkBa";

const feedFor = (positions) => ({
  chain: "solana",
  programId: "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv",
  name: "Zebec SuperApp staking",
  positions,
  lockups: [{ stakeVault: VAULT_A }, { stakeVault: VAULT_B }],
});

const sumBalances = (wallets) => wallets.reduce((sum, wallet) => sum + (Number(wallet.solana_balance) || 0), 0);

describe("attributeCustodyStaking", () => {
  it("credits stakers, drains every stake vault, and keeps the total", () => {
    const balances = new Map([[VAULT_A, 60], [VAULT_B, 40], [REWARD, 5], [ALICE, 10]]);
    const report = attributeCustodyStaking(balances, new Map([[ALICE, 70], [BOB, 30]]), [VAULT_A, VAULT_B]);
    expect(report).toMatchObject({ held: 100, stakers: 2, overAttributed: 0, residual: 0 });
    expect(balances.get(ALICE)).toBe(80);
    expect(balances.get(BOB)).toBe(30);
    expect(balances.get(VAULT_A)).toBe(0);
    expect(balances.get(VAULT_B)).toBe(0);
    expect(balances.get(REWARD)).toBe(5);
    expect([...balances.values()].reduce((sum, value) => sum + value, 0)).toBe(115);
  });

  it("scales credits down when positions exceed custody and does not invent tokens", () => {
    const balances = new Map([[VAULT_A, 60], [VAULT_B, 40]]);
    const report = attributeCustodyStaking(balances, new Map([[ALICE, 80], [BOB, 30]]), [VAULT_A, VAULT_B]);
    expect(report.overAttributed).toBeCloseTo(10);
    expect(report.attributed).toBeCloseTo(100);
    expect(balances.get(ALICE)).toBeCloseTo(80 * (100 / 110));
    expect(balances.get(BOB)).toBeCloseTo(30 * (100 / 110));
    expect((balances.get(VAULT_A) ?? 0) + (balances.get(VAULT_B) ?? 0)).toBeCloseTo(0);
    expect([...balances.values()].reduce((sum, value) => sum + value, 0)).toBeCloseTo(100);
  });

  it("leaves unattributed vault remainder in place, and a second pass does nothing once custody is empty", () => {
    const partial = new Map([[VAULT_A, 50], [VAULT_B, 10]]);
    const first = attributeCustodyStaking(partial, new Map([[ALICE, 40]]), [VAULT_A, VAULT_B]);
    expect(first.residual).toBeCloseTo(20);
    expect(first.attributed).toBe(40);
    expect(partial.get(ALICE)).toBe(40);

    const drained = new Map([[VAULT_A, 100], [ALICE, 10]]);
    attributeCustodyStaking(drained, new Map([[ALICE, 100]]), [VAULT_A]);
    const again = attributeCustodyStaking(drained, new Map([[ALICE, 100]]), [VAULT_A]);
    expect(again.attributed).toBe(0);
    expect(drained.get(ALICE)).toBe(110);
    expect(drained.get(VAULT_A)).toBe(0);
  });
});

describe("applySolanaStakingSnapshot", () => {
  const snapshot = () => ({
    wallets: [
      { address: ALICE, solana_balance: 10, total_telcoin_balance: 10 },
      { address: VAULT_A, solana_balance: 60, total_telcoin_balance: 60 },
      { address: VAULT_B, solana_balance: 40, total_telcoin_balance: 40 },
      { address: REWARD, solana_balance: 5, total_telcoin_balance: 5 },
      { address: CEX, solana_balance: 20, total_telcoin_balance: 20 },
    ],
    chains: {
      solana: {
        holders: [{ address: ALICE, balance: 10 }],
        metrics: { holderCount: 1, totalBalance: 10, retail: { count: 0, balance: 0 }, underThreshold: { count: 1, balance: 10 }, excluded: { count: 3, balance: 125 } },
      },
    },
    combined: { holderCount: 1, totalBalance: 10, retail: { count: 0, balance: 0 }, underThreshold: { count: 1, balance: 10 }, excluded: { count: 3, balance: 125 } },
  });

  it("puts staked balances on retail stakers and drops emptied stake vaults", () => {
    const before = sumBalances(snapshot().wallets);
    const { snapshot: next, report } = applySolanaStakingSnapshot(
      snapshot(),
      feedFor([{ staker: ALICE, amount: 70 }, { staker: BOB, amount: 30 }, { staker: CEX, amount: 0 }]),
      { isNonRetail: (address) => address === CEX, retailThreshold: 1000 },
    );
    expect(report.attributed).toBe(100);
    expect(sumBalances(next.wallets)).toBeCloseTo(before);
    expect(next.wallets.find((wallet) => wallet.address === VAULT_A)).toBeUndefined();
    expect(next.wallets.find((wallet) => wallet.address === VAULT_B)).toBeUndefined();
    expect(next.wallets.find((wallet) => wallet.address === REWARD).solana_balance).toBe(5);
    expect(next.wallets.find((wallet) => wallet.address === ALICE).solana_balance).toBe(80);
    expect(next.wallets.find((wallet) => wallet.address === BOB).solana_balance).toBe(30);
    const holders = next.chains.solana.holders;
    expect(holders.find((holder) => holder.address === ALICE).balance).toBe(80);
    expect(holders.find((holder) => holder.address === BOB).balance).toBe(30);
    expect(holders.find((holder) => holder.address === CEX)).toBeUndefined();
    expect(holders.find((holder) => holder.address === REWARD)).toBeUndefined();
    expect(next.combined.totalBalance).toBe(110);
    expect(next.chains.solana.metrics.excluded).toEqual({ count: 3, balance: 125 });
  });

  it("does not add a non-retail stake-only wallet to the retail holder list", () => {
    const { snapshot: next } = applySolanaStakingSnapshot(
      snapshot(),
      feedFor([{ staker: CEX, amount: 100 }]),
      { isNonRetail: (address) => address === CEX },
    );
    expect(next.wallets.find((wallet) => wallet.address === CEX).solana_balance).toBe(120);
    expect(next.chains.solana.holders.map((holder) => holder.address)).toEqual([ALICE]);
    expect(next.combined.totalBalance).toBe(10);
  });

  it("leaves a snapshot alone when there is nothing to credit", () => {
    const input = snapshot();
    const { snapshot: next, report } = applySolanaStakingSnapshot(input, feedFor([]));
    expect(report).toBeNull();
    expect(next).toBe(input);
    expect(attributeSolanaStakingBalances(new Map([[VAULT_A, 1]]), { positions: [], lockups: [] })).toBeNull();
  });
});
