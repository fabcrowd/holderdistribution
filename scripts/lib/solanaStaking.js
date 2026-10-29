/**
 * Solana program staking (staking[].kind such as "zebecStakeV1").
 *
 * pull-solana-staking.js writes public/data/<slug>/solana-staking.json.
 * loadSolanaStakingPositions shapes that feed like TEL's v3 overlay so
 * buildStakingStats can count stakers. The Staked tile stays a subset.
 *
 * The holder snapshot itself follows TEL: attributeSolanaStakingBalances
 * credits each position to the staker and reduces stake-vault custody by the
 * same amount (attributeCustodyStaking), so Retail includes staked tokens
 * once. Reward vaults are not custody for those positions and stay put.
 * generate-holders-lite must not add the overlay on top of those balances.
 */
import { normalizeAddressForVm } from "./address.js";
import { attributeCustodyStaking } from "./stakingCustody.js";
import { computeChainMetrics } from "./holderMetrics.js";

export const loadSolanaStakingPositions = (feed) => {
  if (!feed?.positions?.length) return null;
  const positions = new Map();
  for (const p of feed.positions) {
    const a = normalizeAddressForVm("solana", p?.staker);
    const amount = Number(p?.amount);
    if (!a || !Number.isFinite(amount) || amount <= 0) continue;
    positions.set(a, (positions.get(a) ?? 0) + amount);
  }
  if (positions.size === 0) return null;
  return {
    chain: feed.chain ?? "solana",
    modules: [{ address: feed.programId, name: feed.name ?? "Solana staking", deployBlock: null, deployDate: null, lastBlock: feed.slot ?? null }],
    positions,
  };
};

/** Stake-vault holder rows (PDAs) named on the feed. Reward vaults are not included. */
export const stakeVaultAddresses = (feed) => {
  const out = [];
  const seen = new Set();
  for (const lockup of feed?.lockups ?? []) {
    const address = normalizeAddressForVm("solana", lockup?.stakeVault);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
};

/**
 * Credits solana-staking.json positions onto one chain's balance map and
 * reduces stake-vault custody. No-op when the feed or the vault balances
 * are missing (TEL, or a second pass after custody was already moved).
 *
 * @param {Map<string, number>} balances
 * @param {object} feed solana-staking.json
 */
export const attributeSolanaStakingBalances = (balances, feed) => {
  const overlay = loadSolanaStakingPositions(feed);
  const custody = stakeVaultAddresses(feed);
  if (!balances || !overlay || custody.length === 0) return null;
  return attributeCustodyStaking(balances, overlay.positions, custody);
};

/**
 * Applies attributeSolanaStakingBalances to an already-built holder snapshot
 * (wallets + per-chain holder rows + metrics). Used to restate a snapshot
 * that was scanned before this rule. Custody vaults stay out of the retail
 * holder list; stake-only stakers are added unless `isNonRetail` rejects them.
 * Does not mutate the input.
 */
export const applySolanaStakingSnapshot = (
  snapshot,
  feed,
  { isNonRetail = () => false, retailThreshold = 1000, megaThreshold = Number.POSITIVE_INFINITY } = {},
) => {
  const overlay = loadSolanaStakingPositions(feed);
  const custody = stakeVaultAddresses(feed);
  if (!snapshot || !overlay || custody.length === 0) return { snapshot, report: null };

  const chainKey = overlay.chain;
  const balKey = `${chainKey}_balance`;
  const wallets = (snapshot.wallets ?? []).map((wallet) => ({ ...wallet }));
  const index = new Map(wallets.map((wallet) => [wallet.address, wallet]));
  const balances = new Map();
  for (const wallet of wallets) {
    const balance = Number(wallet[balKey]) || 0;
    if (balance > 0) balances.set(wallet.address, balance);
  }
  const before = new Map(balances);
  const report = attributeCustodyStaking(balances, overlay.positions, custody);
  if (!(report.attributed > 0)) return { snapshot, report };

  const custodySet = new Set(custody);
  for (const [address, balance] of balances) {
    const prev = before.get(address) ?? 0;
    if (balance === prev && index.has(address)) continue;
    let wallet = index.get(address);
    if (!wallet) {
      wallet = { address, [balKey]: 0, total_telcoin_balance: 0 };
      wallets.push(wallet);
      index.set(address, wallet);
    }
    const old = Number(wallet[balKey]) || 0;
    wallet[balKey] = balance;
    wallet.total_telcoin_balance = (Number(wallet.total_telcoin_balance) || 0) + (balance - old);
  }
  const kept = wallets.filter((wallet) => (Number(wallet.total_telcoin_balance) || 0) > 0);
  kept.sort((a, b) => (Number(b.total_telcoin_balance) || 0) - (Number(a.total_telcoin_balance) || 0));

  const chains = { ...(snapshot.chains ?? {}) };
  const chain = chains[chainKey];
  if (chain) {
    const holders = (chain.holders ?? []).map((holder) => ({ ...holder }));
    const holderIndex = new Map(holders.map((holder) => [holder.address, holder]));
    for (const [address, balance] of balances) {
      if (custodySet.has(address) || !(balance > 0)) continue;
      const existing = holderIndex.get(address);
      if (existing) {
        if (balance > megaThreshold) {
          holderIndex.delete(address);
        } else {
          existing.balance = balance;
        }
        continue;
      }
      if (before.has(address)) continue;
      if (isNonRetail(address) || balance > megaThreshold) continue;
      holderIndex.set(address, { address, balance });
    }
    // The raw holder array can still contain addresses the non-retail set
    // rejects (lite filters those; stored metrics already exclude them).
    // Recompute from the same visible set lite will sum, so Retail Held and
    // the supply retail bucket stay the same number.
    const nextHolders = [...holderIndex.values()].filter((holder) => Number(holder.balance) > 0 && holder.balance <= megaThreshold);
    nextHolders.sort((a, b) => b.balance - a.balance);
    const visible = nextHolders.filter((holder) => !isNonRetail(holder.address));
    const metrics = computeChainMetrics(visible, { retailThreshold });
    chains[chainKey] = {
      ...chain,
      holders: nextHolders,
      metrics: {
        ...(chain.metrics ?? {}),
        holderCount: metrics.holderCount,
        totalBalance: metrics.totalBalance,
        retail: metrics.retail,
        underThreshold: metrics.underThreshold,
      },
    };
  }

  const combined = {
    ...(snapshot.combined ?? {}),
    holderCount: 0,
    totalBalance: 0,
    retail: { count: 0, balance: 0 },
    underThreshold: { count: 0, balance: 0 },
  };
  for (const entry of Object.values(chains)) {
    combined.holderCount += entry.metrics?.holderCount ?? 0;
    combined.totalBalance += entry.metrics?.totalBalance ?? 0;
    combined.retail = {
      count: combined.retail.count + (entry.metrics?.retail?.count ?? 0),
      balance: combined.retail.balance + (entry.metrics?.retail?.balance ?? 0),
    };
    combined.underThreshold = {
      count: combined.underThreshold.count + (entry.metrics?.underThreshold?.count ?? 0),
      balance: combined.underThreshold.balance + (entry.metrics?.underThreshold?.balance ?? 0),
    };
  }

  return { snapshot: { ...snapshot, wallets: kept, chains, combined }, report };
};
