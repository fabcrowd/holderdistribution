import { normalizeAnyAddress } from "./address.js";
// Hex lowercased; Solana base58 kept as written.
const normalizeAddress = (value) => normalizeAnyAddress(value);

/**
 * Builds the per-chain retail holder list from a raw tel-holders.json
 * snapshot: filters non-retail addresses, and seeds each holder with
 * `stakedBalance: 0` (populated later by applyStaking) and
 * `totalBalance: balance` (staking-inclusive already, from
 * pull-holders-rpc.js's own merge).
 */
export const buildChainHolders = (snapshot, isNonRetailAddress) => {
  const chains = {};
  for (const [key, chain] of Object.entries(snapshot?.chains ?? {})) {
    const holders = (chain?.holders ?? [])
      .filter((holder) => holder?.address)
      .filter((holder) => !isNonRetailAddress(holder.address))
      .map((holder) => ({
        address: holder.address,
        balance: holder.balance ?? 0,
        stakedBalance: 0,
        totalBalance: holder.balance ?? 0,
      }));
    chains[key] = {
      key,
      name: chain.label ?? chain.key ?? key,
      holders,
    };
  }
  return chains;
};

/** Aggregate holder-count/balance stats for a flat holder list. */
export const buildMetrics = (holders) => {
  const totalBalance = holders.reduce(
    (sum, holder) => sum + (holder.totalBalance ?? holder.balance ?? 0),
    0,
  );
  return {
    holderCount: holders.length,
    totalBalance,
    retail: { count: holders.length, balance: totalBalance },
    underThreshold: { count: 0, balance: 0 },
    mega: { count: 0, balance: 0 },
    excluded: { count: 0, balance: 0 },
  };
};

/**
 * Attributes each funding wallet's staked amount onto its matching holder as
 * `stakedBalance` — informational, feeding stats like "N stakers, X TEL
 * staked" — WITHOUT adding it into `totalBalance`.
 *
 * pull-holders-rpc.js already merges staking into the `balance` field this
 * reads (`chainBalancesRaw.polygon.set(addr, existing + stakedAmount)`), so
 * every holder's `balance`/`totalBalance` coming in is already
 * staking-inclusive. An earlier version of this function ALSO did
 * `totalBalance: holder.balance + updatedStake`, adding the same staked
 * amount a second time on top of an already-inclusive balance.
 *
 * Proven exactly against shipped data: `sum(chain holder balances,
 * non-retail excluded) + fundingWallets stakedTotal` matched the live (wrong)
 * `combined.totalBalance` to the dollar — e.g. 66,504,892,253 + 4,671,679,427
 * = 71,176,571,680. "Total TEL Held" was overstated by the full staked total.
 *
 * Stake is attributed ONLY on the chain the staking contract lives on, read
 * from `fundingWallets.source.chain` (the puller records it). Attributing
 * across all chains by address alone put stake on whichever chain happened to
 * iterate last — see the per-chain index below.
 *
 * @param {Record<string, {holders: Array<{address: string, balance?: number, stakedBalance?: number, totalBalance?: number}>}>} chains
 * @param {{source?: {chain?: string}, wallets?: Array<{fundingWallet?: string, address?: string, stakedAmount?: number, stakers?: Array<{stakerWallet?: string, stakedAmount?: number}>}>}} fundingWallets
 * @param {{warn?: Function}} logger injectable for tests
 */
export const applyStaking = (chains, fundingWallets, logger = console) => {
  const wallets = fundingWallets?.wallets ?? [];
  if (!wallets.length) return chains;

  const stakingChainKey = normalizeAddress(fundingWallets?.source?.chain);
  if (!stakingChainKey) {
    logger.warn?.(
      "WARNING: funding-wallets.json has no source.chain — cannot tell which chain the staking " +
        "contract lives on, so staking was not attributed. Re-run pull-staker-balances.js.",
    );
    return chains;
  }

  const stakedMap = new Map();
  const addStake = (address, rawAmount) => {
    const normalized = normalizeAddress(address);
    const amount = Number(rawAmount ?? 0);
    if (!normalized || !Number.isFinite(amount) || amount <= 0) return;
    const existing = stakedMap.get(normalized) ?? 0;
    stakedMap.set(normalized, existing + amount);
  };

  for (const entry of wallets) {
    const stakers = Array.isArray(entry?.stakers) ? entry.stakers : [];
    if (stakers.length > 0) {
      for (const staker of stakers) {
        addStake(staker?.stakerWallet, staker?.stakedAmount);
      }
      continue;
    }
    addStake(entry?.fundingWallet ?? entry?.address, entry?.stakedAmount);
  }

  if (stakedMap.size === 0) return chains;

  // Index ONLY the staking chain. A single flat address->entry map across all
  // chains is last-write-wins, so a staker who also held TEL on a
  // later-iterating chain had their stake recorded there instead. That is how
  // 98,498,426 TEL across 4 "stakers" came to be reported on Base — a chain
  // with no staking contract — while Polygon was short by exactly that amount.
  const stakingChain = chains[stakingChainKey];
  if (!stakingChain) {
    logger.warn?.(
      `WARNING: staking chain "${stakingChainKey}" is absent from the holder set — ` +
        "staking was not attributed.",
    );
    return chains;
  }

  const holderIndex = new Map();
  stakingChain.holders = (stakingChain.holders ?? []).map((holder, index) => {
    const normalized = normalizeAddress(holder.address);
    if (normalized) holderIndex.set(normalized, index);
    return holder;
  });

  const unmatched = [];
  for (const [normalized, amount] of stakedMap.entries()) {
    const index = holderIndex.get(normalized);
    if (index === undefined) {
      unmatched.push({ address: normalized, stakedBalance: amount });
      continue;
    }
    const holder = stakingChain.holders[index];
    const updatedStake = (holder.stakedBalance ?? 0) + amount;
    stakingChain.holders[index] = {
      ...holder,
      stakedBalance: updatedStake,
      // totalBalance is deliberately left as-is (== holder.balance, already
      // staking-inclusive from upstream). Do not add `updatedStake` here —
      // that was the double-count.
    };
  }

  if (unmatched.length > 0) {
    // Should be rare-to-never: pull-holders-rpc.js's own staking merge
    // already creates a holder entry for every staker, including
    // zero-liquid ones — so a funding wallet with no matching holder here
    // would mean that merge didn't run, or its coverage regressed.
    // Surfaced rather than silently falling back to a synthetic chain, so a
    // real gap doesn't hide.
    logger.warn?.(
      `WARNING: ${unmatched.length} staker(s) from funding-wallets.json have no matching holder entry ` +
        `in any chain — expected 0, since pull-holders-rpc.js's merge should already cover every staker.`
    );
    chains.staking = {
      key: "staking",
      name: "Staking",
      holders: unmatched.map((entry) => ({
        address: entry.address,
        balance: 0,
        stakedBalance: entry.stakedBalance,
        totalBalance: entry.stakedBalance,
      })),
    };
  }

  return chains;
};
