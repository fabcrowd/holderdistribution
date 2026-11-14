import { describe, expect, it, vi } from "vitest";
import { loadedAdapterVms, stakingInfoFor } from "./chainAdapters.js";
import { resolveNetworkStake, withNetworkStake } from "./networkStake.js";

const HEDERA = { key: "hedera", vm: "hedera" };
const EVM = { key: "ethereum" };
const SOLANA = { key: "solana", vm: "solana" };
const quiet = { log: () => {}, warn: () => {} };
const GOOD = {
  available: true,
  stakedTotal: 13_456_711_853,
  stakedTotalTinybar: "1345671185300000000",
  stakedTotalHbar: "13456711853.00000000",
  decimals: 8,
  stakingPeriod: { start: "2026-11-13T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" },
  source: "mirror node /network/stake",
};

describe("resolveNetworkStake", () => {
  it("is null for an evm-only project and never asks a port", async () => {
    const port = vi.fn();
    expect(await resolveNetworkStake([EVM, { key: "polygon" }], { stakingInfoFor: port, logger: quiet })).toBeNull();
    expect(port).not.toHaveBeenCalled();
  });

  it("is null when the chain's vm has no stakingInfo port", async () => {
    expect(await resolveNetworkStake([SOLANA], { stakingInfoFor: async () => undefined, logger: quiet })).toBeNull();
  });

  it("carries the chain key with the port's own staking period", async () => {
    const r = await resolveNetworkStake([HEDERA], { stakingInfoFor: async () => GOOD, logger: quiet });
    expect(r).toEqual({ chainKey: "hedera", ...GOOD });
  });

  it("turns a rejecting port into an explicit unavailable block", async () => {
    const r = await resolveNetworkStake([HEDERA], { stakingInfoFor: async () => { throw new Error("boom"); }, logger: quiet });
    expect(r).toMatchObject({ chainKey: "hedera", available: false, reason: expect.stringContaining("boom") });
    expect(r).not.toHaveProperty("stakedTotal");
  });

  it("keeps an unavailable result from the port as is", async () => {
    const down = { available: false, reason: "mirror node request failed (HTTP 503)", source: "mirror node /network/stake" };
    expect(await resolveNetworkStake([HEDERA], { stakingInfoFor: async () => down, logger: quiet })).toEqual({ chainKey: "hedera", ...down });
  });
});

describe("withNetworkStake: informational only", () => {
  // Every number a consistency check or the holder views read.
  const lite = {
    generatedAt: "2026-11-13T06:00:00Z",
    asOf: { date: "2026-11-12", blocks: { hedera: 1 }, settled: true },
    thresholds: { retail: 1000, megaHolder: 10_000_000_000 },
    totals: { totalSupply: 50_000_000_000 },
    source: null,
    chainOrder: ["hedera"],
    views: {
      combined: {
        key: "combined",
        metrics: { holderCount: 681_576, totalBalance: 37_786_224_531, retail: { count: 600_000, balance: 37_786_224_531 }, excluded: { count: 3, balance: 5_802_295_204 } },
        stakingStats: { stakerCount: 0, holderCount: 681_576, stakedTotal: 0, stakedShareOfRetail: 0, stakerShareOfHolders: 0, averageStakedPerStaker: 0 },
      },
    },
    overlap: null,
    cex: { overall: { currentBalance: 5_779_921_419 } },
  };

  it.each([["present", GOOD], ["unavailable", { available: false, reason: "down" }]])("leaves every existing field unchanged when the value is %s", (_l, info) => {
    const { networkStake, ...rest } = withNetworkStake(structuredClone(lite), { chainKey: "hedera", ...info });
    expect(networkStake).toMatchObject({ chainKey: "hedera", available: info.available });
    expect(rest).toEqual(lite);
  });

  it("returns the feed untouched when there is no value", () => {
    expect(withNetworkStake(lite, null)).toBe(lite);
    expect(Object.keys(withNetworkStake(lite, null))).not.toContain("networkStake");
  });

  it("does not mutate the feed it was given", () => {
    const copy = structuredClone(lite);
    withNetworkStake(copy, { chainKey: "hedera", ...GOOD });
    expect(copy).toEqual(lite);
  });
});

describe("stakingInfoFor port", () => {
  it("is undefined for evm and solana without loading any adapter module", async () => {
    const before = loadedAdapterVms();
    expect(await stakingInfoFor(EVM)).toBeUndefined();
    expect(await stakingInfoFor(SOLANA)).toBeUndefined();
    expect(loadedAdapterVms()).toEqual(before);
  });
});
