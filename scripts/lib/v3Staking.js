/**
 * TEL v3 StakingModule positions for the published staking stats.
 *
 * Staked TEL used to mean the legacy Polygon staking contract only
 * (funding-wallets.json, stakedBy() reads). Since the v3 StakingModule went
 * live (Polygon 0x573105be…5731, deploy block 93,048,895, 2026-09-01 UTC)
 * stakers have been migrating to it, so the legacy figure alone fell by
 * ~3.25B YTD while the TEL simply moved to the new module.
 *
 * pull-holders-rpc.js already replays the module's receipt-token Transfer
 * logs and checkpoints every staker's position in
 * holders-checkpoint.json → chains.<chain>.v3Staking[module].rawBalances
 * (18-decimal integers). Those positions are already inside each staker's
 * wallet balance (attributeStakingReceipts), so here they are only an
 * informational overlay — exactly like the legacy `stakedBalance` — and must
 * never be added to any balance again.
 */

const normalize = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** UTC date (YYYY-MM-DD) of the first day whose end block is at or after `block`. */
export const dateForBlock = (asOfBlocks, chainKey, block) => {
  if (!asOfBlocks || !Number.isFinite(block)) return null;
  const dates = Object.keys(asOfBlocks).sort();
  for (const date of dates) {
    const b = Number(asOfBlocks[date]?.[chainKey]);
    if (Number.isFinite(b) && b >= block) return date;
  }
  return null;
};

const toTokens = (raw, decimals) => {
  let big;
  try {
    big = BigInt(raw);
  } catch {
    return 0;
  }
  if (big <= 0n) return 0;
  const scale = 10n ** BigInt(decimals);
  // Whole part exactly, fraction to 1e-6 — plenty at TEL magnitudes.
  return Number(big / scale) + Number((big % scale) / 10n ** BigInt(Math.max(0, decimals - 6))) / 1e6;
};

/**
 * Reads every configured v3 staking module's positions out of the checkpoint.
 *
 * @param {object} checkpoint holders-checkpoint.json
 * @param {object} chainConfig config/chains.json (chain key -> chain meta)
 * @param {object} [asOfBlocks] data/holders-asof-blocks.json, to date the deploy block
 * @returns {null | { chain: string, modules: Array<{address: string, name: string, deployBlock: number|null, deployDate: string|null, lastBlock: number|null}>, positions: Map<string, number> }}
 */
export const loadV3StakingPositions = (checkpoint, chainConfig, asOfBlocks = null) => {
  const positions = new Map();
  const modules = [];
  let chain = null;
  // config/chains.json is keyed by chain at the top level.
  for (const [chainKey, meta] of Object.entries(chainConfig ?? {})) {
    if (!meta || typeof meta !== "object") continue;
    for (const module of meta?.tokens?.v3?.staking ?? []) {
      const address = normalize(module.address);
      if (!address) continue;
      const entry = checkpoint?.chains?.[chainKey]?.v3Staking?.[address];
      if (!entry?.rawBalances) continue;
      chain = chainKey;
      const decimals = Number.isFinite(module.decimals) ? module.decimals : 18;
      for (const [staker, raw] of Object.entries(entry.rawBalances)) {
        const a = normalize(staker);
        if (!a || a === address) continue;
        const amount = toTokens(raw, decimals);
        if (amount > 0) positions.set(a, (positions.get(a) ?? 0) + amount);
      }
      const deployBlock = Number.isFinite(module.deployBlock) ? module.deployBlock : Number(entry.fromBlock) || null;
      modules.push({
        address,
        name: module.name ?? "v3 StakingModule",
        deployBlock,
        deployDate: dateForBlock(asOfBlocks, chainKey, deployBlock),
        lastBlock: Number(entry.lastBlock) || null,
      });
    }
  }
  return modules.length ? { chain, modules, positions } : null;
};

/**
 * Marks each v3 staker's holder row with `stakedV3Balance` on the module's
 * chain. Informational only: `balance`/`totalBalance` already contain it.
 * Stakers outside the retail set have no row; they still count in the
 * staking totals via buildStakingStats' module-wide summary.
 */
export const applyV3Staking = (chains, v3) => {
  if (!v3?.positions?.size || !v3.chain) return chains;
  const chain = chains?.[v3.chain];
  if (!chain) return chains;
  chain.holders = (chain.holders ?? []).map((holder) => {
    const amount = v3.positions.get(normalize(holder.address));
    return amount ? { ...holder, stakedV3Balance: (holder.stakedV3Balance ?? 0) + amount } : holder;
  });
  return chains;
};

/**
 * Legacy + v3 staking summary for one view, deduped by staker address.
 *
 * @param {Array<{address: string, stakedBalance?: number}>} holders the view's holder rows (legacy stake per row)
 * @param {null | {positions: Map<string, number>, modules: Array<object>}} v3 module-wide positions, or null when the view has none
 */
export const summarizeStaking = (holders, v3) => {
  const legacy = new Map();
  for (const h of holders) {
    const amount = Number(h?.stakedBalance ?? 0);
    const a = normalize(h?.address);
    if (a && Number.isFinite(amount) && amount > 0) legacy.set(a, (legacy.get(a) ?? 0) + amount);
  }
  const v3Positions = v3?.positions ?? new Map();
  const all = new Set([...legacy.keys(), ...v3Positions.keys()]);
  let both = 0;
  for (const a of legacy.keys()) if (v3Positions.has(a)) both += 1;
  const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  return {
    stakers: all,
    perStaker: (a) => (legacy.get(a) ?? 0) + (v3Positions.get(a) ?? 0),
    legacy: { stakerCount: legacy.size, stakedTotal: sum(legacy) },
    v3: v3
      ? {
          stakerCount: v3Positions.size,
          stakedTotal: sum(v3Positions),
          modules: v3.modules ?? [],
          deployDate: (v3.modules ?? []).map((m) => m.deployDate).filter(Boolean).sort()[0] ?? null,
        }
      : null,
    bothCount: both,
  };
};
