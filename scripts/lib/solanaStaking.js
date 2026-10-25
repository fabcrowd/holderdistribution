/**
 * Solana program staking overlay (staking[].kind such as "zebecStakeV1").
 * Reads public/data/<slug>/solana-staking.json (scripts/pull-solana-staking.js)
 * into the shape loadV3StakingPositions returns, so buildStakingStats counts
 * every staker while holder balances stay untouched (staked != retail: the
 * tokens sit in program vaults classified role "staking").
 */
import { normalizeAddressForVm } from "./address.js";

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
