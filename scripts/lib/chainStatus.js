/**
 * chain-status.json: the ~200-byte slice of holders-checkpoint.json the
 * browser actually needs (each chain's last scanned block, for the "data as of
 * block N" links). The full checkpoint is ~5 MB of per-address balances and is
 * never fetched by the site.
 */
/**
 * @param {object} checkpoint holders-checkpoint.json payload
 * @param {string[]} [chainKeys] the project's chains[].key, in config order
 *   (the callers pass them from the registry). Omitted/empty: every chain the
 *   checkpoint itself carries, in its own order.
 */
export function buildChainStatus(checkpoint, chainKeys) {
  const chains = {};
  for (const key of chainKeys?.length ? chainKeys : Object.keys(checkpoint?.chains ?? {})) {
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
