import { describe, expect, it } from "vitest";
import { applyV3Staking, dateForBlock, loadV3StakingPositions, summarizeStaking } from "./v3Staking.js";
import { buildStakingDistribution, buildStakingStats, buildSnapshotData, buildViewData } from "./holdersView.js";

const MODULE = "0x573105be2148b8621f202a6d510016a2aa825731";
const config = {
  ethereum: { tokens: { v3: {} } },
  polygon: { tokens: { v3: { staking: [{ address: MODULE, name: "TEL v3 StakingModule", decimals: 18, deployBlock: 100 }] } } },
};
const e18 = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
const checkpoint = {
  chains: {
    polygon: {
      v3Staking: {
        [MODULE]: { fromBlock: 100, lastBlock: 500, rawBalances: { "0xAAA": e18(1000), "0xbbb": e18(250.5), [MODULE]: e18(9) } },
      },
    },
  },
};
const asOf = { "2026-08-31": { polygon: 99 }, "2026-09-01": { polygon: 157 }, "2026-09-02": { polygon: 200 } };

describe("v3 staking positions", () => {
  it("reads checkpoint receipts as TEL, lowercases stakers, ignores the module itself", () => {
    const v3 = loadV3StakingPositions(checkpoint, config, asOf);
    expect(v3.chain).toBe("polygon");
    expect([...v3.positions.entries()]).toEqual([["0xaaa", 1000], ["0xbbb", 250.5]]);
    expect(v3.modules[0]).toMatchObject({ address: MODULE, deployBlock: 100, deployDate: "2026-09-01", lastBlock: 500 });
  });

  it("returns null when no module has checkpointed positions", () => {
    expect(loadV3StakingPositions({ chains: {} }, config)).toBeNull();
  });

  it("dates a block to the first day whose end block reaches it", () => {
    expect(dateForBlock(asOf, "polygon", 99)).toBe("2026-08-31");
    expect(dateForBlock(asOf, "polygon", 100)).toBe("2026-09-01");
    expect(dateForBlock(asOf, "polygon", 9999)).toBeNull();
  });

  it("dedupes stakers present in both contracts and sums their stake", () => {
    const v3 = loadV3StakingPositions(checkpoint, config, asOf);
    const holders = [
      { address: "0xaaa", stakedBalance: 40 },
      { address: "0xccc", stakedBalance: 60 },
      { address: "0xddd", stakedBalance: 0 },
    ];
    const s = summarizeStaking(holders, v3);
    expect(s.stakers.size).toBe(3); // aaa (both), bbb (v3), ccc (legacy)
    expect(s.bothCount).toBe(1);
    expect(s.perStaker("0xaaa")).toBe(1040);
    expect(s.legacy).toEqual({ stakerCount: 2, stakedTotal: 100 });
    expect(s.v3).toMatchObject({ stakerCount: 2, stakedTotal: 1250.5, deployDate: "2026-09-01" });
  });

  it("combined stats = legacy + v3, with the split kept", () => {
    const v3 = loadV3StakingPositions(checkpoint, config, asOf);
    const holders = [{ address: "0xaaa", stakedBalance: 40 }, { address: "0xccc", stakedBalance: 60 }];
    const stats = buildStakingStats(holders, 10_000, v3);
    expect(stats.stakedTotal).toBeCloseTo(1350.5);
    expect(stats.stakerCount).toBe(3);
    expect(stats.legacy.stakedTotal).toBe(100);
    expect(stats.v3).toMatchObject({ stakerCount: 2, deployDate: "2026-09-01", deployBlock: 100, module: MODULE });
    expect(stats.stakedInBoth).toBe(1);
    const dist = buildStakingDistribution(holders, v3);
    expect(dist.distributionBuckets.reduce((s, b) => s + b.count, 0)).toBe(3);
  });

  it("without v3 the stats are the legacy-only ones", () => {
    const stats = buildStakingStats([{ address: "0xa", stakedBalance: 5 }], 100);
    expect(stats).toMatchObject({ stakerCount: 1, stakedTotal: 5, legacy: { stakerCount: 1, stakedTotal: 5 } });
    expect(stats.v3).toBeUndefined();
  });

  it("marks retail rows on the module chain without touching balances", () => {
    const v3 = loadV3StakingPositions(checkpoint, config, asOf);
    const chains = { polygon: { holders: [{ address: "0xAAA", balance: 1500, totalBalance: 1500 }] }, ethereum: { holders: [{ address: "0xaaa", balance: 7 }] } };
    applyV3Staking(chains, v3);
    expect(chains.polygon.holders[0]).toEqual({ address: "0xAAA", balance: 1500, totalBalance: 1500, stakedV3Balance: 1000 });
    expect(chains.ethereum.holders[0].stakedV3Balance).toBeUndefined();
  });

  it("v3 reaches the combined and polygon views only, and never changes retail balance", () => {
    const v3 = loadV3StakingPositions(checkpoint, config, asOf);
    const snapshot = {
      chainOrder: ["ethereum", "polygon"],
      chains: {
        ethereum: { holders: [{ address: "0xeee", balance: 10 }] },
        polygon: { holders: [{ address: "0xaaa", balance: 1500 }, { address: "0xbbb", balance: 300 }] },
      },
    };
    const withV3 = buildSnapshotData(snapshot, null, () => false, v3);
    const without = buildSnapshotData(snapshot, null, () => false);
    expect(withV3.combined.totalBalance).toBe(without.combined.totalBalance);
    expect(buildViewData("combined", withV3, null).stakingStats.stakedTotal).toBeCloseTo(1250.5);
    expect(buildViewData("polygon", withV3, null).stakingStats.v3.stakerCount).toBe(2);
    expect(buildViewData("ethereum", withV3, null).stakingStats.stakedTotal).toBe(0);
  });
});

const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("v3Staking normalize keeps Solana base58 case", () => {
  it("overlays a Solana position onto the case-exact holder row without changing balances", () => {
    const chains = { solana: { holders: [{ address: ALICE, balance: 10, totalBalance: 10 }] } };
    const v3 = { chain: "solana", modules: [], positions: new Map([[ALICE, 2.5]]) };
    expect(applyV3Staking(chains, v3).solana.holders[0]).toEqual({ address: ALICE, balance: 10, totalBalance: 10, stakedV3Balance: 2.5 });
  });

  it("EVM stays lowercased (TEL unchanged)", () => {
    const chains = { polygon: { holders: [{ address: "0xABCDEF0000000000000000000000000000000001", balance: 1 }] } };
    const v3 = { chain: "polygon", modules: [], positions: new Map([["0xabcdef0000000000000000000000000000000001", 4]]) };
    expect(applyV3Staking(chains, v3).polygon.holders[0].stakedV3Balance).toBe(4);
    expect(summarizeStaking([], v3).v3.stakedTotal).toBe(4);
  });
});
