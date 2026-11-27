import { ARCHIVE_UNAVAILABLE_PATTERN } from "./rpc.js";
import { isLimitedPublicUrl, backoffMs } from "./rpcLimiter.js";
import { classifyProvider, isAlchemyBudgetError } from "./rpcMetrics.js";

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
 * Alchemy budget (config/nightly-jobs.json `alchemyCuPerNight`, enforced by the
 * rpc.js guard): once one Alchemy URL is refused with AlchemyBudgetError, every
 * Alchemy URL is refused for the rest of the process, so they are all skipped from
 * then on instead of being asked (and refused) one by one. 2026-11-27 (run
 * 45975348118): the TEL staker scan's pool was 15 Alchemy keys, the budget ran out
 * after 985 CU, every "next RPC URL" was another Alchemy key and the step failed
 * without ever asking a free endpoint.
 *
 * `reserve` (string[] or a function returning one, resolved once and only when
 * needed): URLs to try after every pool URL failed or was skipped for budget, e.g.
 * the chain's keyless public endpoints for a keyed pool, or the keys for a public
 * pool (rpc.js getReserveRpcUrls). Once added they stay in the rotation.
 *
 * Returns a function with its own memory, so tests and runs do not share state.
 * `getLogsWithFailover.lastServedUrl` is the URL that answered last, so a
 * sequential scan can keep asking the endpoint that just worked.
 *
 * @param {(url: string, filter: object) => Promise<object[]>} getLogsImpl
 * @param {{warn?: Function}} [logger]
 * @param {{ sleep?: (ms: number) => Promise<void>, reserve?: string[] | (() => string[] | Promise<string[]>) }} [opts]
 */
export function createLogsFailover(getLogsImpl, logger = console, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), reserve = null } = {}) {
  const noHistoryBelow = new Map();
  const demoted = new Set();
  let alchemySpent = false;
  let reserveUrls = null;
  let reserveAnnounced = false;
  const usable = (u) => !(alchemySpent && classifyProvider(u) === "alchemy");
  const resolveReserve = async () => {
    if (reserveUrls === null) {
      const value = typeof reserve === "function" ? await reserve() : reserve;
      reserveUrls = Array.isArray(value) ? value.filter((u) => typeof u === "string" && u.length > 0) : [];
    }
    return reserveUrls;
  };

  async function getLogsWithFailover(rpcUrls, preferredIdx, filter) {
    const from = Number.parseInt(filter.fromBlock, 16);
    const serves = (u) => !(Number.isFinite(from) && from < (noHistoryBelow.get(u) ?? 0));
    const ordered = (list, start = 0) => {
      const order = [];
      for (let i = 0; i < list.length; i++) order.push(list[(start + i) % list.length]);
      const candidates = [
        ...order.filter((u) => serves(u) && !demoted.has(u)),
        ...order.filter((u) => serves(u) && demoted.has(u)),
      ];
      // Every URL ruled out for this range: still try them all rather than fail unasked.
      return candidates.length > 0 ? candidates : order;
    };
    // The reserve joins once the pool has failed in this process (or is empty);
    // after that it stays in the rotation for later chunks too.
    let attempts = ordered(rpcUrls.length > 0 ? rpcUrls : [], rpcUrls.length > 0 ? preferredIdx : 0);
    let reserveAdded = false;
    const addReserve = async () => {
      reserveAdded = true;
      const extra = (await resolveReserve()).filter((u) => usable(u) && !attempts.includes(u));
      if (extra.length === 0) return false;
      if (!reserveAnnounced) {
        reserveAnnounced = true;
        logger.warn?.(`  getLogs: the RPC pool cannot serve this scan${alchemySpent ? " (Alchemy budget spent)" : ""} — adding ${extra.length} reserve URL(s).`);
      }
      attempts = [...attempts, ...extra];
      return true;
    };
    if (reserveUrls !== null && reserveAnnounced) await addReserve();

    // Keyless public pools get extra rounds: when every endpoint failed a range
    // (rate-limited, timed out, or at the split floor), wait with jittered
    // backoff and rotate through them again, then give up with the error so the
    // scan exits non-zero (with its partial checkpoint) instead of looping.
    // Keyed pools keep exactly one pass, as before.
    const rounds = () => (attempts.some((u) => isLimitedPublicUrl(u)) ? Math.max(1, Number(process.env.RPC_FAILOVER_ROUNDS) || 3) : 1);
    let lastError;
    for (let round = 0; round < rounds(); round++) {
      if (round > 0) {
        const waitMs = Math.round(backoffMs(round + 1, { baseMs: 2000, capMs: 60_000 }));
        logger.warn?.(`  getLogs ${from}: every RPC URL failed — round ${round + 1}/${rounds()} in ${waitMs}ms (${String(lastError?.message ?? lastError).slice(0, 80)}).`);
        await sleep(waitMs);
      }
      const pass = attempts.filter(usable);
      for (let i = 0; i < pass.length; i++) {
        const url = pass[i];
        if (!usable(url)) continue; // the budget ran out earlier in this pass
        try {
          const logs = await getLogsImpl(url, filter);
          getLogsWithFailover.lastServedUrl = url;
          return logs;
        } catch (error) {
          lastError = error;
          const message = String(error?.message ?? error);
          if (isAlchemyBudgetError(error)) {
            if (!alchemySpent) logger.warn?.(`  getLogs: Alchemy budget spent (${message.slice(0, 80)}) — skipping every Alchemy URL from now on.`);
            alchemySpent = true;
            continue;
          }
          if (ARCHIVE_UNAVAILABLE_PATTERN.test(message)) {
            const boundary = EARLIEST_AVAILABLE.exec(message);
            if (boundary) noHistoryBelow.set(url, Number(boundary[1]));
            else demoted.add(url);
          }
          if (i < pass.length - 1) {
            logger.warn?.(`  getLogs failed on …${url.slice(-4)} (${message.slice(0, 80)}) — trying next RPC URL.`);
          }
        }
      }
      // The whole pool failed (or was skipped for budget): bring in the reserve once
      // and start the rounds again with it.
      if (!reserveAdded && reserve !== null && (await addReserve())) round = -1;
    }
    throw lastError ?? new Error("getLogs: no usable RPC URL (pool empty, Alchemy budget spent, no reserve)");
  }
  getLogsWithFailover.lastServedUrl = null;
  return getLogsWithFailover;
}
