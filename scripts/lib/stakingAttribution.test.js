import { describe, expect, it, vi } from "vitest";
import { applyStaking } from "./stakingAttribution.js";

const silent = { warn: vi.fn() };

// buildChainHolders' output shape: `balance`/`totalBalance` already
// staking-inclusive (pull-holders-rpc.js merges staking upstream), with
// `stakedBalance` initialized to 0.
const chainsWith = (holders) => ({
  polygon: { key: "polygon", name: "Polygon", holders },
});

// Every fixture must declare which chain the staking contract lives on —
// applyStaking reads it from funding-wallets.json's own `source.chain`.
const funding = (wallets) => ({ source: { chain: "polygon" }, wallets });

describe("applyStaking", () => {
  it("does NOT add staked amount into totalBalance a second time", () => {
    // The exact bug: holder.balance is already staking-inclusive (say the
    // wallet holds 1,000 TEL total, 400 of it staked). The old
    // implementation did `totalBalance: holder.balance + updatedStake`,
    // producing 1,400 — inflating the wallet's balance by the staked amount
    // it already contained.
    const chains = chainsWith([
      { address: "0xAAAA000000000000000000000000000000aaaa", balance: 1000, stakedBalance: 0, totalBalance: 1000 },
    ]);
    const fundingWallets = funding([{ fundingWallet: "0xAAAA000000000000000000000000000000aaaa", stakedAmount: 400 }]);

    const result = applyStaking(chains, fundingWallets, silent);
    const holder = result.polygon.holders[0];

    expect(holder.stakedBalance).toBe(400);
    expect(holder.totalBalance).toBe(1000); // unchanged — NOT 1400
    expect(holder.balance).toBe(1000);
  });

  it("reproduces the exact production discrepancy when the bug is present", () => {
    // Real figures from the shipped data (2026-08-07): summing chain holder
    // balances (already staking-inclusive) plus funding-wallets.json's
    // staked total exactly matched the live (wrong) combined.totalBalance —
    // proving the double-count, not just asserting it in the abstract.
    const chainSum = 66_504_892_253;
    const stakedTotal = 4_671_679_427;
    const liveWrongTotalBalance = 71_176_571_680;
    expect(chainSum + stakedTotal).toBe(liveWrongTotalBalance);

    // With the fix, combined totalBalance must equal chainSum alone —
    // funding-wallets' stakedTotal must contribute 0 to it.
    const chains = chainsWith([
      { address: "0xbbbb000000000000000000000000000000bbbb", balance: chainSum, stakedBalance: 0, totalBalance: chainSum },
    ]);
    const fundingWallets = funding([{ fundingWallet: "0xbbbb000000000000000000000000000000bbbb", stakedAmount: stakedTotal }]);

    const result = applyStaking(chains, fundingWallets, silent);
    expect(result.polygon.holders[0].totalBalance).toBe(chainSum);
    expect(result.polygon.holders[0].totalBalance).not.toBe(liveWrongTotalBalance);
  });

  it("still attributes stakedBalance for downstream staking stats", () => {
    // stakedBalance feeds buildStakingStats/buildStakingDistribution in
    // generate-holders-lite.js — deleting attribution entirely (rather than
    // just fixing the double-add) would silently zero those out.
    const chains = chainsWith([
      { address: "0xcccc000000000000000000000000000000cccc", balance: 500, stakedBalance: 0, totalBalance: 500 },
    ]);
    const fundingWallets = funding([{ fundingWallet: "0xcccc000000000000000000000000000000cccc", stakedAmount: 200 }]);

    const result = applyStaking(chains, fundingWallets, silent);
    expect(result.polygon.holders[0].stakedBalance).toBe(200);
  });

  it("sums multiple stakers under one funding wallet onto the same holder", () => {
    const chains = chainsWith([
      { address: "0xdddd000000000000000000000000000000dddd", balance: 10, stakedBalance: 0, totalBalance: 10 },
    ]);
    const fundingWallets = funding([
      {
        fundingWallet: "0xzzzz000000000000000000000000000000zzzz",
        stakers: [
          { stakerWallet: "0xdddd000000000000000000000000000000dddd", stakedAmount: 100 },
          { stakerWallet: "0xdddd000000000000000000000000000000dddd", stakedAmount: 50 },
        ],
      },
    ]);

    const result = applyStaking(chains, fundingWallets, silent);
    expect(result.polygon.holders[0].stakedBalance).toBe(150);
    expect(result.polygon.holders[0].totalBalance).toBe(10); // still unchanged
  });

  it("never attributes stake to a chain that has no staking contract", () => {
    // The live bug: holderIndex was ONE flat address->{chain,index} map built
    // across every chain, so `set` was last-write-wins. A Polygon staker who
    // also held TEL on Base (which iterates later) was recorded under Base, and
    // their stake applied there. Shipped data showed 98,498,426 TEL across 4
    // "stakers" on Base — a chain with no staking contract — while Polygon was
    // short by exactly that amount.
    const staker = "0xa1a1000000000000000000000000000000a1a1";
    const chains = {
      polygon: {
        key: "polygon",
        name: "Polygon",
        holders: [{ address: staker, balance: 5000, stakedBalance: 0, totalBalance: 5000 }],
      },
      // Iterates AFTER polygon — this ordering is what triggered the bug.
      base: {
        key: "base",
        name: "Base",
        holders: [{ address: staker, balance: 7, stakedBalance: 0, totalBalance: 7 }],
      },
    };
    const fundingWallets = funding([{ fundingWallet: staker, stakedAmount: 4000 }]);

    const result = applyStaking(chains, fundingWallets, silent);

    expect(result.polygon.holders[0].stakedBalance).toBe(4000);
    expect(result.base.holders[0].stakedBalance).toBe(0);
    // Balances stay untouched on both chains (the double-count fix).
    expect(result.polygon.holders[0].totalBalance).toBe(5000);
    expect(result.base.holders[0].totalBalance).toBe(7);
  });

  it("does not attribute staking when funding-wallets.json omits source.chain", () => {
    // Without source.chain there is no way to know which chain the contract
    // lives on. Guessing is what produced the Base leak, so bail loudly.
    const chains = chainsWith([
      { address: "0xb2b2000000000000000000000000000000b2b2", balance: 100, stakedBalance: 0, totalBalance: 100 },
    ]);
    const logger = { warn: vi.fn() };

    const result = applyStaking(
      chains,
      { wallets: [{ fundingWallet: "0xb2b2000000000000000000000000000000b2b2", stakedAmount: 50 }] },
      logger,
    );

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(result.polygon.holders[0].stakedBalance).toBe(0);
  });

  it("warns (not silently) when a staker has no matching holder anywhere", () => {
    // Should be rare-to-never given pull-holders-rpc.js's own merge covers
    // every staker, including zero-liquid ones — a miss here is a real
    // signal, not expected behavior, so it must not pass silently.
    const chains = chainsWith([]);
    const fundingWallets = funding([{ fundingWallet: "0xeeee000000000000000000000000000000eeee", stakedAmount: 999 }]);
    const logger = { warn: vi.fn() };

    const result = applyStaking(chains, fundingWallets, logger);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(result.staking.holders).toEqual([
      { address: "0xeeee000000000000000000000000000000eeee", balance: 0, stakedBalance: 999, totalBalance: 999 },
    ]);
  });

  it("is a no-op when there are no funding wallets", () => {
    const chains = chainsWith([{ address: "0xffff000000000000000000000000000000ffff", balance: 1, stakedBalance: 0, totalBalance: 1 }]);
    const result = applyStaking(chains, funding([]), silent);
    expect(result).toBe(chains);
    expect(silent.warn).not.toHaveBeenCalled();
  });
});
