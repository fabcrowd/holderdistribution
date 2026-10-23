/**
 * chain-status.json: the ~200-byte slice of holders-checkpoint.json the
 * browser actually needs (each chain's last scanned block, for the "data as of
 * block N" links). The full checkpoint is ~5 MB of per-address balances and is
 * never fetched by the site.
 */
export const CHAIN_STATUS_CHAINS = ["ethereum", "polygon", "base"];

export function buildChainStatus(checkpoint) {
  const chains = {};
  for (const key of CHAIN_STATUS_CHAINS) {
    const lastBlock = Number(checkpoint?.chains?.[key]?.lastBlock);
    if (Number.isFinite(lastBlock) && lastBlock > 0) chains[key] = { lastBlock };
  }
  return { generatedAt: checkpoint?.generatedAt ?? null, chains };
}
