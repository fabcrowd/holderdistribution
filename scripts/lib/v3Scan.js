import { applyV3Batch, emptyV3State, v3StateFromCheckpoint } from "./telTokens.js";

/**
 * Incremental TEL v3 scan for one chain.
 *
 * For every block range it fetches (a) all v3 Transfer logs and (b) the legacy
 * token's Transfer logs INTO the upgrade contracts, then folds both into the v3
 * state in one step so a swap's two legs (legacy in, v3 out) are always seen
 * together — same transaction means same block means same range.
 *
 * Resumes from a checkpoint `v3` section; with none, starts at the v3 deployment
 * block (v3 balances are exactly zero before it, so earlier snapshots remain
 * valid and nothing before the deployment is ever fetched).
 *
 * The fetchers are injected so the range/resume maths is unit-testable without a
 * network: `fetchV3(from, to)` and `fetchEscrowLegacy(from, to)` each resolve to
 * an array of raw logs.
 *
 * @param {object} p
 * @param {number} p.deployBlock
 * @param {number} p.toBlock inclusive upper bound (shared with the legacy scan so both tokens describe one block)
 * @param {number} p.chunkSize
 * @param {number} [p.concurrency]
 * @param {object|null} p.checkpoint the chain checkpoint's `v3` section
 * @param {Function} p.fetchV3
 * @param {Function} p.fetchEscrowLegacy
 * @param {{escrow: string[], legacyDecimals: number, v3Decimals: number}} p.cfg
 * @param {Function} [p.onProgress]
 * @returns {Promise<{state: ReturnType<typeof emptyV3State>, fromBlock: number, toBlock: number, v3Logs: number, swapLogs: number}>}
 */
export async function scanV3Chain({
  deployBlock,
  toBlock,
  chunkSize,
  concurrency = 1,
  checkpoint = null,
  fetchV3,
  fetchEscrowLegacy,
  cfg,
  onProgress = () => {},
}) {
  if (!Number.isFinite(deployBlock) || deployBlock <= 0) {
    throw new Error("scanV3Chain needs the v3 deployBlock (config/chains.json tokens.v3.deployBlock)");
  }
  const state = checkpoint ? v3StateFromCheckpoint(checkpoint) : emptyV3State();
  const fromBlock = checkpoint && Number.isFinite(Number(checkpoint.lastBlock))
    ? Number(checkpoint.lastBlock) + 1
    : deployBlock;

  const ranges = [];
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    ranges.push({ from, to: Math.min(from + chunkSize - 1, toBlock) });
  }

  let v3Logs = 0;
  let swapLogs = 0;
  const width = Math.max(1, concurrency);
  for (let i = 0; i < ranges.length; i += width) {
    const slice = ranges.slice(i, i + width);
    const results = await Promise.all(
      slice.map(async ({ from, to }) => {
        const [v3, escrowLegacy] = await Promise.all([fetchV3(from, to), fetchEscrowLegacy(from, to)]);
        return { from, to, v3, escrowLegacy };
      }),
    );
    for (const r of results) {
      // Balance and retirement maths are commutative across ranges (all adds and
      // subtracts), and a swap never straddles a range boundary, so the order the
      // parallel results are folded in does not matter.
      applyV3Batch(state, r.v3, r.escrowLegacy, cfg);
      v3Logs += r.v3.length;
      swapLogs += r.escrowLegacy.length;
      if (r.v3.length > 0 || r.escrowLegacy.length > 0) onProgress(r);
    }
  }
  return { state, fromBlock, toBlock, v3Logs, swapLogs };
}
