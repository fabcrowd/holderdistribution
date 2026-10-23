import { STAKE_CHANGED_TOPIC0, parseStakeChangedAccount } from "./staking.js";

/**
 * Block the Polygon staking proxy (0x92e43aec...6330) was deployed at, found
 * with an eth_getCode bisection on 2026-10-23 (no code at 36,751,756, code at
 * 36,751,757). No StakeChanged log can exist before it, so the keyless scan
 * below starts here instead of at genesis.
 */
export const STAKING_DEPLOY_BLOCK = 36_751_757;

/**
 * Default chunk for the keyless scan. Tenderly's public Polygon gateway accepts
 * 1,000,000-block eth_getLogs on this contract (~60 requests for the full
 * history); endpoints with a smaller cap are handled by rpc.getLogs, which
 * bisects on "range too large" and remembers the working span per URL.
 */
export const STAKE_SCAN_SPAN = 1_000_000;

/**
 * Candidate discovery for pull-staker-balances.js straight from JSON-RPC
 * eth_getLogs, so the staker feed no longer depends on an Etherscan API key.
 * The previous code ALWAYS went through Etherscan for this step; with no key
 * (or the key's quota gone) the whole staker refresh exited before doing
 * anything, which left funding-wallets.json frozen at 4.17B staked while the
 * contract's own totalStaked() read ~0.8B after the TEL v3 upgrade.
 *
 * @param {object} opts
 * @param {(urls: string[], preferredIdx: number, filter: object) => Promise<object[]>} opts.getLogsWithFailover
 * @param {string[]} opts.urls
 * @param {string} opts.contract
 * @param {number} opts.fromBlock
 * @param {number} opts.toBlock
 * @param {(value: string) => string|null} opts.normalize
 * @param {number} [opts.span]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ candidates: Set<string>, logCount: number }>}
 */
export async function scanStakeChangedCandidates({
  getLogsWithFailover,
  urls,
  contract,
  fromBlock,
  toBlock,
  normalize,
  span = STAKE_SCAN_SPAN,
  log = () => {},
}) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("scanStakeChangedCandidates: no RPC URLs");
  if (!(span >= 1)) throw new Error("scanStakeChangedCandidates: span must be >= 1");
  const candidates = new Set();
  let logCount = 0;
  let chunk = 0;
  for (let start = fromBlock; start <= toBlock; start += span) {
    const end = Math.min(start + span - 1, toBlock);
    const logs = await getLogsWithFailover(urls, chunk % urls.length, {
      address: contract,
      topics: [STAKE_CHANGED_TOPIC0],
      fromBlock: "0x" + start.toString(16),
      toBlock: "0x" + end.toString(16),
    });
    chunk++;
    for (const entry of logs) {
      const account = parseStakeChangedAccount(entry, normalize);
      if (account) candidates.add(account);
    }
    logCount += logs.length;
    log(`  Blocks ${start}-${end}: ${logs.length} logs, ${candidates.size} unique accounts so far (total logs: ${logCount})`);
  }
  return { candidates, logCount };
}
