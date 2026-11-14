/**
 * Hedera wallet-flows scan: every HBAR transfer SENT by a sender account (the project's treasury accounts),
 * stored raw (sender, recipient, tinybar, consensus stamp). Venues are not decided here: the report labels
 * the recipients with the current CEX and DEX lists, so a list change never needs a rescan.
 *
 * One stream at a time, sequentially. A stream is a contiguous run of sender ids (the treasury ids are a handful of
 * runs, so an idle account costs nothing) read through the mirror's own list with an account.id range:
 *   /transactions?account.id=gte:<from>&account.id=lte:<to>&timestamp=gt:<cursor>&timestamp=lte:<through>&order=asc&limit=100
 * Paging follows `links.next` (flowScan.readPage): a non-null next always continues, a null next ends the
 * range, anything unreadable is a failure that keeps the cursor and leaves the scan incomplete.
 *
 * The transaction rules are the exchange-flow classifier's (flowClassify.classifyHederaTx): every record once,
 * fees and staking-reward legs removed, failed transactions move nothing but fees. Here every sender plays the
 * "exchange" role, so a record's `cexOut` events are exactly its transfers sent by a sender. A record touching
 * several senders (also across streams) is processed once, by the stream holding the lowest sender id among them
 * (canonicalOwner), never by config order; that choice depends on the sender set, which is why the stored scan is
 * stamped with a hash of it (walletFlowSenders.scanHash).
 */
import { canonicalOwner, classifyHederaTx } from "./flowClassify.js";
import { FLOW_PAGE_SIZE, MAX_FAILED_ACCOUNTS, nanosOf, readPage, UNPAIRED_COUNTERPARTY } from "./flowScan.js";
import { assertStreamable, compareIds, contiguousRanges } from "./walletFlowSenders.js";

const NANOS_PER_SECOND = 1_000_000_000n;
/** Streams of a sender set: contiguous id runs, each with its cursor key. Throws when a sender is a network-busy account. */
export function senderStreams(senders) {
  assertStreamable(senders);
  return contiguousRanges(senders).map((r) => ({ ...r, key: streamKey(r) }));
}
export const streamKey = ({ from, to }) => (from === to ? from : `${from}..${to}`);
const streamQuery = ({ from, to }) => (from === to ? `account.id=${from}` : `account.id=gte:${from}&account.id=lte:${to}`);

/**
 * Where a page that is followed by more continues: its `until` (the last row, or for an empty page the bound the
 * mirror's next link advanced to), else the last row. It must move the cursor forward, or the scan would loop.
 */
function continueFrom(page, current, key, through) {
  const until = page.until ?? page.txs.at(-1)?.consensus_timestamp;
  if (until === undefined || nanosOf(until) <= nanosOf(current) || nanosOf(until) > nanosOf(through)) throw new Error(`hedera /transactions: ${key} has more pages but its cursor cannot advance from ${current} within ${through}`);
  return until;
}

export const secondsOf = (stamp) => Number(nanosOf(stamp) / NANOS_PER_SECOND);

/**
 * Raw events of one record: transfers sent by a sender ({ w: sender, d: recipient }) and, with `inbound`, transfers
 * received by one ({ w: sender, d: source, dir: "in" }; the ledger needs both, the wallet-flows report only outflows).
 */
export function senderEvents(tx, roles, { inbound = false } = {}) {
  const { events, audit } = classifyHederaTx(tx, roles);
  const out = [];
  const t = secondsOf(tx.consensus_timestamp);
  for (const e of events) {
    const other = e.counterparty ?? UNPAIRED_COUNTERPARTY;
    if (e.kind === "cexOut") out.push({ w: e.venue, d: other, raw: e.raw, sig: tx.consensus_timestamp, t });
    else if (e.kind === "cexIn" && inbound) out.push({ w: e.venue, d: other, raw: e.raw, sig: tx.consensus_timestamp, t, dir: "in" });
  }
  return { events: out, audit };
}

/**
 * @param {object} p
 * @param {{ getJson: Function }} p.client
 * @param {string[]} p.senders ids (any order)
 * @param {Record<string, { until: string }>} [p.cursors] previous cursors by stream key (missing = start at p.start)
 * @param {string} p.start consensus stamp a new sender starts after
 * @param {string} p.through consensus end of the settled day
 * @param {boolean} [p.inbound] also keep transfers received by a sender (ledger)
 * @param {number} [p.deadlineMs] stop cleanly before the next page once passed
 * @param {(page: { newEvents: object[], cursors: object }) => Promise<void>} [p.onProgress] after every page
 */
export async function scanSenderFlows({ client, senders, cursors, start, through, deadlineMs = Infinity, onProgress = null, inbound = false, logger = console, now = Date.now }) {
  const order = [...senders].sort(compareIds);
  const streams = senderStreams(order);
  const roles = { cex: new Map(order.map((id) => [id, id])) };
  const endNanos = nanosOf(through);
  const next = Object.fromEntries(streams.map((st) => [st.key, { until: cursors?.[st.key]?.until ?? start }]));
  const stats = { pages: 0, transactions: 0, owned: 0, events: 0, failedTransactions: 0, feeUnmatched: 0, rewardRecords: 0, emptyContinuationPages: 0 };
  const events = [];
  const failed = [];
  let timedOut = false;

  for (const st of streams) {
    if (timedOut || failed.length >= MAX_FAILED_ACCOUNTS) break;
    const own = new Set(order.filter((id) => compareIds(id, st.from) >= 0 && compareIds(id, st.to) <= 0));
    while (nanosOf(next[st.key].until) < endNanos) {
      if (now() >= deadlineMs) {
        timedOut = true;
        break;
      }
      const path = `/transactions?${streamQuery(st)}&timestamp=gt:${next[st.key].until}&timestamp=lte:${through}&order=asc&limit=${FLOW_PAGE_SIZE}`;
      let page;
      let emptyUntil = null;
      try {
        page = readPage(await client.getJson(path), path);
        // An empty page with a next link is the mirror saying "nothing up to this bound": the bound must move the cursor forward within the range.
        if (page.more && page.txs.length === 0) emptyUntil = continueFrom(page, next[st.key].until, st.key, through);
      } catch (e) {
        failed.push({ account: st.key, message: String(e?.message ?? e).replace(/^mirror GET \S+ /, "mirror GET <url> ").slice(0, 300) });
        logger.warn?.(`  ${st.key}: ${failed.at(-1).message}; cursor kept at ${next[st.key].until}`);
        break;
      }
      let last = nanosOf(next[st.key].until);
      const fresh = [];
      for (const tx of page.txs) {
        const t = nanosOf(tx.consensus_timestamp);
        if (t <= last || t > endNanos) throw new Error(`hedera /transactions: ${tx.consensus_timestamp} out of order or outside (${next[st.key].until}, ${through}]`);
        last = t;
        stats.transactions += 1;
        const owner = canonicalOwner(tx, order);
        if (owner === null || !own.has(owner)) continue;
        stats.owned += 1;
        const { events: found, audit } = senderEvents(tx, roles, { inbound });
        if (tx.result !== "SUCCESS") stats.failedTransactions += 1;
        if (!audit.feeMatched) stats.feeUnmatched += 1;
        if (audit.reward !== 0n) stats.rewardRecords += 1;
        fresh.push(...found);
      }
      stats.pages += 1;
      stats.events += fresh.length;
      if (emptyUntil !== null) stats.emptyContinuationPages += 1;
      next[st.key] = { until: !page.more ? through : emptyUntil ?? continueFrom(page, next[st.key].until, st.key, through) };
      events.push(...fresh);
      if (onProgress) await onProgress({ newEvents: fresh, cursors: { ...next } });
    }
  }
  return { cursors: next, events, stats, timedOut, failed, streams: streams.map((st) => st.key) };
}
