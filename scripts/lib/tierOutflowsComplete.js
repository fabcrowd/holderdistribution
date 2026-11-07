/**
 * Whether one chain's tier-outflows checkpoint has caught up. The scan ends at the
 * shared settled cutoff (cutoff[today]-1), not at the chain tip, so a chain is caught
 * up once its lastBlock reaches the recorded settled target. Without a target (no
 * cutoff resolved yet) it falls back to the old rule: within one day of blocks of the
 * tip recorded by this run.
 */
export function chainCaughtUp(cp, blocksPerDay) {
  if (!cp || cp.lastBlock == null) return false;
  if (Number.isInteger(cp.settledTarget)) return cp.lastBlock >= cp.settledTarget;
  return cp.latest != null && cp.latest - cp.lastBlock <= blocksPerDay;
}
