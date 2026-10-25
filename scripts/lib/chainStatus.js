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
    const entry = checkpoint?.chains?.[key];
    const lastBlock = Number(entry?.lastBlock);
    if (!(Number.isFinite(lastBlock) && lastBlock > 0)) continue;
    // Solana: lastBlock is the snapshot SLOT; scannedAt lets the UI mark the
    // chain stale when this run kept a previous (failed-chain) entry. EVM
    // entries keep exactly { lastBlock }.
    chains[key] = entry?.vm === "solana"
      ? { lastBlock, vm: "solana", ...(entry.scannedAt ? { scannedAt: entry.scannedAt } : {}) }
      : { lastBlock };
  }
  return { generatedAt: checkpoint?.generatedAt ?? null, chains };
}
