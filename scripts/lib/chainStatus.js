/**
 * chain-status.json: the ~200-byte slice of holders-checkpoint.json the
 * browser actually needs (each chain's last scanned block, for the "data as of
 * block N" links). The full checkpoint is ~5 MB of per-address balances and is
 * never fetched by the site.
 */
/** TEL's chains: the default when a caller does not pass the project's keys. */
export const CHAIN_STATUS_CHAINS = ["ethereum", "polygon", "base"];

/**
 * @param {object} checkpoint holders-checkpoint.json payload
 * @param {string[]} [chainKeys] the project's chains[].key, in config order
 *   (pull-holders-rpc passes them, so a project with e.g. arbitrum gets it).
 */
export function buildChainStatus(checkpoint, chainKeys = CHAIN_STATUS_CHAINS) {
  const chains = {};
  for (const key of chainKeys?.length ? chainKeys : CHAIN_STATUS_CHAINS) {
    const lastBlock = Number(checkpoint?.chains?.[key]?.lastBlock);
    if (Number.isFinite(lastBlock) && lastBlock > 0) chains[key] = { lastBlock };
  }
  return { generatedAt: checkpoint?.generatedAt ?? null, chains };
}
