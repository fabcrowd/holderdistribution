/**
 * Which staking contract scripts/pull-staker-balances.js reads for a project:
 * the project's `staking[]` entry with `kind: "stakeChanged"` (StakeChanged
 * events for candidate discovery + stakedBy(address) for balances), plus the
 * chain id and the staked token's address/decimals from the same config.
 *
 * TEL resolves to exactly the values the script used to hardcode: Polygon
 * (137), proxy 0x92e43aec…6330, legacy TEL 0xdf7837de…cc32 (2 decimals),
 * deploy block 36_751_757 (scripts/lib/stakingDiscovery.js).
 *
 * Returns null when the project has no such contract (the script then skips).
 */
export function resolveStakeChangedTarget(project) {
  const entries = (project.config?.staking ?? []).filter((s) => s.kind === "stakeChanged");
  if (entries.length === 0) return null;
  if (entries.length > 1) {
    throw new Error(`project ${project.slug}: more than one "stakeChanged" staking contract is not supported yet`);
  }
  const s = entries[0];
  const chain = (project.config?.chains ?? []).find((c) => c.key === s.chain);
  if (!chain) throw new Error(`project ${project.slug}: staking chain "${s.chain}" is not in chains[]`);
  const generation = s.token ?? null;
  const tokens = chain.tokens ?? [];
  const token = generation ? tokens.find((t) => t.generation === generation) : tokens.length === 1 ? tokens[0] : null;
  if (!token) throw new Error(`project ${project.slug}: no ${generation ?? "single"} token on ${s.chain} for staking ${s.address}`);
  const deployBlock = Number(s.deployBlock);
  if (!Number.isInteger(deployBlock) || deployBlock <= 0) {
    throw new Error(`project ${project.slug}: staking ${s.address} needs a deployBlock (StakeChanged scan start)`);
  }
  return {
    chain: s.chain,
    chainId: chain.chainId,
    contract: s.address.toLowerCase(),
    tokenAddress: token.address.toLowerCase(),
    decimals: token.decimals,
    deployBlock,
    name: s.name ?? null,
  };
}
