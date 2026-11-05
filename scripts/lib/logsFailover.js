import { ARCHIVE_UNAVAILABLE_PATTERN } from "./rpc.js";
import { isLimitedPublicUrl, backoffMs } from "./rpcLimiter.js";

const EARLIEST_AVAILABLE = /earliest available (\d+)/i;

/**
 * eth_getLogs with failover across an RPC pool, aware of nodes that do not serve
 * old blocks.
 *
 * Tries the chunk's assigned URL first, then every other URL in the pool: a pool of
 * keyless public endpoints (the fallback when all Alchemy keys are dead) has members
 * that each reject things differently or go down mid-run, so one endpoint's failure
 * must not fail a chunk another could serve. With a single URL this is a plain call.
 *
 * The v3 scan starts at the v3 deployment block (weeks back) and free public nodes
 * differ wildly in how far back they serve. Two kinds of "no history" answer:
 *  - with a boundary ("pruned history unavailable: ... earliest available N"): the URL
 *    is skipped for every range below N and used again from N on;
 *  - without one (publicnode: "Archive requests require a personal token"): the URL
 *    is demoted to last resort so it is not asked (and refused) on every chunk.
 *
 * Returns a function with its own memory, so tests and runs do not share state.
 *
 * @param {(url: string, filter: object) => Promise<object[]>} getLogsImpl
 * @param {{warn?: Function}} [logger]
 */
export function createLogsFailover(getLogsImpl, logger = console, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const noHistoryBelow = new Map();
  const demoted = new Set();

  return async function getLogsWithFailover(rpcUrls, preferredIdx, filter) {
    const from = Number.parseInt(filter.fromBlock, 16);
    const order = [];
    for (let i = 0; i < rpcUrls.length; i++) order.push(rpcUrls[(preferredIdx + i) % rpcUrls.length]);
    const serves = (u) => !(Number.isFinite(from) && from < (noHistoryBelow.get(u) ?? 0));
    const candidates = [
      ...order.filter((u) => serves(u) && !demoted.has(u)),
      ...order.filter((u) => serves(u) && demoted.has(u)),
    ];
    // Every URL ruled out for this range: still try them all rather than fail unasked.
    const attempts = candidates.length > 0 ? candidates : order;

    // Keyless public pools get extra rounds: when every endpoint failed a range
    // (rate-limited, timed out, or at the split floor), wait with jittered
    // backoff and rotate through them again, then give up with the error so the
    // scan exits non-zero (with its partial checkpoint) instead of looping.
    // Keyed pools keep exactly one pass, as before.
    const rounds = attempts.some((u) => isLimitedPublicUrl(u)) ? Math.max(1, Number(process.env.RPC_FAILOVER_ROUNDS) || 3) : 1;
    let lastError;
    for (let round = 0; round < rounds; round++) {
      if (round > 0) {
        const waitMs = Math.round(backoffMs(round + 1, { baseMs: 2000, capMs: 60_000 }));
        logger.warn?.(`  getLogs ${from}: every RPC URL failed — round ${round + 1}/${rounds} in ${waitMs}ms (${String(lastError?.message ?? lastError).slice(0, 80)}).`);
        await sleep(waitMs);
      }
      for (let i = 0; i < attempts.length; i++) {
        const url = attempts[i];
        try {
          return await getLogsImpl(url, filter);
        } catch (error) {
          lastError = error;
          const message = String(error?.message ?? error);
          if (ARCHIVE_UNAVAILABLE_PATTERN.test(message)) {
            const boundary = EARLIEST_AVAILABLE.exec(message);
            if (boundary) noHistoryBelow.set(url, Number(boundary[1]));
            else demoted.add(url);
          }
          if (i < attempts.length - 1) {
            logger.warn?.(`  getLogs failed on …${url.slice(-4)} (${message.slice(0, 80)}) — trying next RPC URL.`);
          }
        }
      }
    }
    throw lastError;
  };
}
