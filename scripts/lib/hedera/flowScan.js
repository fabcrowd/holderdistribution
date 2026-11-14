/**
 * Hedera exchange-flow scan. One exchange account at a time, sequentially, through the mirror
 * node's own transaction list for that account:
 *
 *   /transactions?account.id=<id>&timestamp=gt:<cursor>&timestamp=lte:<through>&order=asc&limit=100
 *
 * `through` is the consensus end of the settled day: the last consensus time of block
 * cutoff[D+1]-1, the same boundary lib/hedera/settle.js reads the holders snapshot at. A
 * transaction belongs to the day whose (previous end, end] interval holds its consensus time,
 * which is exactly the block-cutoff day of the repo's convention (blocks are consecutive and
 * their consensus ranges are disjoint).
 *
 * Resume: each account has its own cursor (`until`, a consensus stamp: everything at or before
 * it was processed). A record touching several exchange accounts is processed by the lowest account id
 * among them only (canonicalOwner), so it is counted once whatever order the accounts progress in. That
 * choice depends on the account set, so a stored scan is only valid for the set it was made with
 * (flowConfig.js planFlowResume rebuilds when the set changes).
 * Paging follows the mirror's `links.next` (see readPage). Events are delivered per page; the caller stores them and then the cursor, and a
 * page re-delivered after a crash between the two is dropped by flowFeeds.applyFlowEventsOnce
 * (signature = consensus timestamp).
 *
 * Nothing is skipped on error: the client retries with backoff, and a page that still fails
 * leaves that account's cursor where it was and is reported in `failed`.
 */
import { canonicalOwner, classifyHederaTx } from "./flowClassify.js";

export const FLOW_PAGE_SIZE = 100;
/** Accounts whose scan failed before the whole run gives up (the mirror is down, not one account). */
export const MAX_FAILED_ACCOUNTS = 3;
/** Stored counterparty of a transfer remainder that no sender could be paired with. */
export const UNPAIRED_COUNTERPARTY = "unpaired";

export const nanosOf = (stamp) => {
  const [s, f = ""] = String(stamp).split(".");
  return BigInt(s) * 1_000_000_000n + BigInt(f.padEnd(9, "0").slice(0, 9));
};

/** Wraps a mirror client so every request start is counted. */
export function countRequests(client) {
  let n = 0;
  return {
    client: {
      ...client,
      getJson: async (p) => {
        n += 1;
        return client.getJson(p);
      },
      getPage: async (p, o) => {
        n += 1;
        return client.getPage(p, o);
      },
    },
    requests: () => n,
  };
}

/** The date whose (previous end, end] interval holds `stamp`. `ends` is [{ date, end: bigint }] ascending. */
export function dateOfStamp(ends, stamp) {
  const t = nanosOf(stamp);
  const hit = ends.find((e) => t <= e.end);
  if (!hit) throw new Error(`hedera flow scan: ${stamp} is after the last day end`);
  return hit.date;
}

const STAMP_RE = /^\d+(\.\d+)?$/;

/** The ascending `timestamp=gt:<stamp>` bound of a mirror `links.next`, or null. */
function gtBoundOf(next) {
  const query = next.includes("?") ? next.slice(next.indexOf("?") + 1) : "";
  for (const part of query.split("&")) {
    const m = /^timestamp=gt(?::|%3A)(.+)$/i.exec(part);
    if (m && STAMP_RE.test(m[1])) return m[1];
  }
  return null;
}

/**
 * The mirror's own `links.next` is the authority on whether more rows follow, and `until` is the cursor to
 * continue from. Contract: `(body, path) => { txs, more, until }`.
 *   - rows with a non-null next: more true, until = the last row's consensus stamp;
 *   - null next: more false (end of range, whatever the row count: the live mirror sends null on a full page
 *     when nothing follows), until null;
 *   - an EMPTY page with a non-null next: the mirror searches in time windows and says "nothing up to here,
 *     continue": more true, until = the `timestamp=gt:` bound parsed from the next link.
 * Anything unreadable (body, links, next, or an empty-page next without a parseable gt bound) throws. Callers
 * must check that an empty page's `until` moves strictly past their cursor and not beyond the range end
 * (scanHederaFlows does), so a mirror that repeats a window can neither loop nor skip.
 * Ascending only; a descending caller would need the `lt:` bound.
 */
export function readPage(body, path) {
  if (!body || !Array.isArray(body.transactions) || !body.links || !("next" in body.links)) {
    throw new Error(`hedera /transactions: unreadable page for ${path}`);
  }
  const { next } = body.links;
  if (next === null) return { txs: body.transactions, more: false, until: null };
  if (typeof next !== "string") throw new Error(`hedera /transactions: unreadable links.next for ${path}`);
  if (body.transactions.length > 0) return { txs: body.transactions, more: true, until: body.transactions.at(-1).consensus_timestamp };
  const until = gtBoundOf(next);
  if (until === null) throw new Error(`hedera /transactions: links.next on an empty page has no timestamp=gt bound for ${path}`);
  return { txs: body.transactions, more: true, until };
}

/**
 * Scans every account from its cursor to `through`.
 * @param {object} p
 * @param {{ getJson: Function }} p.client
 * @param {Array<{ id: string, exchange: string }>} p.accounts exchange accounts in config order
 * @param {Record<string, { until: string }>} p.cursors previous cursors (missing = start at p.start)
 * @param {string} p.start consensus stamp a new account starts after
 * @param {string} p.through consensus end of the settled day
 * @param {Array<{ date: string, stamp: string }>} p.dayEnds days (first day to settled day) with their consensus end
 * @param {number} [p.deadlineMs] stop cleanly before the next page once passed
 * @param {(page: { newEvents: object[], cursors: object }) => Promise<void>} [p.onProgress] called after every page
 * @returns {Promise<{ cursors: object, events: object[], stats: object, timedOut: boolean, failed: Array<{ account: string, message: string }> }>}
 */
export async function scanHederaFlows({ client, accounts, cursors, start, through, dayEnds, deadlineMs = Infinity, onProgress = null, logger = console, now = Date.now }) {
  const order = accounts.map((a) => a.id);
  const roles = { cex: new Map(accounts.map((a) => [a.id, a.exchange])) };
  const ends = dayEnds.map((d) => ({ date: d.date, end: nanosOf(d.stamp) }));
  const endNanos = nanosOf(through);
  const next = Object.fromEntries(accounts.map((a) => [a.id, { until: cursors?.[a.id]?.until ?? start }]));
  const stats = { pages: 0, emptyContinuationPages: 0, transactions: 0, owned: 0, failedTransactions: 0, childTransactions: 0, scheduledTransactions: 0, internalEvents: 0, feeUnmatched: 0, rewardRecords: 0, rewardPoolFeeShareRecords: 0, rewardResidualTinybar: 0n, nonSuccessWithFlow: 0 };
  const events = [];
  const failed = [];
  let timedOut = false;

  for (const { id } of accounts) {
    if (timedOut || failed.length >= MAX_FAILED_ACCOUNTS) break;
    while (nanosOf(next[id].until) < endNanos) {
      if (now() >= deadlineMs) {
        timedOut = true;
        break;
      }
      const path = `/transactions?account.id=${id}&timestamp=gt:${next[id].until}&timestamp=lte:${through}&order=asc&limit=${FLOW_PAGE_SIZE}`;
      let txs;
      let more;
      let until;
      try {
        ({ txs, more, until } = readPage(await client.getJson(path), path));
        // An empty page's bound must advance past the cursor and stay inside the range, or the scan could loop or skip.
        if (txs.length === 0 && more && !(nanosOf(until) > nanosOf(next[id].until) && nanosOf(until) <= endNanos)) {
          throw new Error(`hedera /transactions: empty page continues at ${until}, not inside (${next[id].until}, ${through}] for ${path}`);
        }
      } catch (e) {
        failed.push({ account: id, message: String(e?.message ?? e).slice(0, 200) });
        logger.warn?.(`  ${id}: ${failed.at(-1).message}; cursor kept at ${next[id].until}`);
        break;
      }
      let last = nanosOf(next[id].until);
      const fresh = [];
      for (const tx of txs) {
        const t = nanosOf(tx.consensus_timestamp);
        if (t <= last || t > endNanos) throw new Error(`hedera /transactions: ${tx.consensus_timestamp} out of order or outside (${next[id].until}, ${through}]`);
        last = t;
        stats.transactions += 1;
        if (canonicalOwner(tx, order) !== id) continue;
        stats.owned += 1;
        const { events: found, audit } = classifyHederaTx(tx, roles);
        if (tx.result !== "SUCCESS") stats.failedTransactions += 1;
        if ((tx.nonce ?? 0) > 0) stats.childTransactions += 1;
        if (tx.scheduled === true) stats.scheduledTransactions += 1;
        if (!audit.feeMatched) stats.feeUnmatched += 1;
        if (audit.reward !== 0n) stats.rewardRecords += 1;
        if (audit.rewardPoolFeeShare !== 0n) stats.rewardPoolFeeShareRecords += 1;
        stats.rewardResidualTinybar += audit.rewardResidual < 0n ? -audit.rewardResidual : audit.rewardResidual;
        if (tx.result !== "SUCCESS" && found.length > 0) stats.nonSuccessWithFlow += 1;
        const date = dateOfStamp(ends, tx.consensus_timestamp);
        for (const e of found) {
          if (e.kind === "internal") stats.internalEvents += 1;
          // An unpaired remainder has no counterparty; keep it as a named one so the day store (which drops
          // null counterparties) still sums to the day's totals. It is never in a holder snapshot, so it lands
          // in the tier feed's unattributed bucket.
          fresh.push({ ...e, counterparty: e.counterparty ?? UNPAIRED_COUNTERPARTY, signature: tx.consensus_timestamp, date });
        }
      }
      stats.pages += 1;
      if (txs.length === 0 && more) stats.emptyContinuationPages += 1;
      // Continue from the parsed stamp, not by following links.next: that link starts with /api/v1 while the client takes paths without it.
      next[id] = { until: more ? until : through };
      events.push(...fresh);
      if (onProgress) await onProgress({ newEvents: fresh, cursors: { ...next } });
    }
  }
  return { cursors: next, events, stats, timedOut, failed };
}
