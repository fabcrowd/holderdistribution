/**
 * The `networkStake` block of holders-lite.json: a native coin's network-wide staked amount, carried
 * beside (never inside) the holder views.
 *
 * Informational only. Staked coins stay in the holder's own account and are already in every holder
 * balance, so nothing here touches retail, holder counts, circulating or any category sum. The block has
 * its own as-of (the staking period the source reports), separate from the snapshot's settled day.
 *
 * Wired by vm through the chain adapters' optional `stakingInfo` port, never by slug. A project with no
 * such chain gets null and its feed is byte-identical to before.
 */
import { resolveChainVm } from "./chainVms.js";

/** The feed with `networkStake` added as its own top-level key; the feed itself when there is none. Touches nothing else. */
export const withNetworkStake = (feed, networkStake) => (networkStake ? { ...feed, networkStake } : feed);

/**
 * { chainKey, ...stakingInfo } for the first chain whose adapter offers a `stakingInfo` port, else null.
 * A port that rejects becomes an explicit unavailable block, so a source outage never fails the run or
 * publishes a number.
 * opts: { stakingInfoFor (test hook), logger }.
 */
export async function resolveNetworkStake(chains, { stakingInfoFor: portFor = null, logger = console } = {}) {
  // evm-only projects (TEL) never load the adapter registry for this.
  const candidates = (chains ?? []).filter((chain) => resolveChainVm(chain) !== "evm");
  if (candidates.length === 0) return null;
  const call = portFor ?? (await import("./chainAdapters.js")).stakingInfoFor;
  for (const chain of candidates) {
    let info;
    try {
      info = await call(chain);
    } catch (error) {
      info = { available: false, reason: `staking source failed (${error?.message ?? error})` };
    }
    if (info === undefined || info === null) continue;
    if (info.available === true) {
      logger.log?.(`  network stake (${chain.key}): ${info.stakedTotalHbar ?? info.stakedTotal} staked, period ${info.stakingPeriod?.start} to ${info.stakingPeriod?.end}`);
    } else {
      logger.warn?.(`  network stake (${chain.key}): unavailable, ${info.reason ?? "no reason given"}`);
    }
    return { chainKey: chain.key, ...info };
  }
  return null;
}
