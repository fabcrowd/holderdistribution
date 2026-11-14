/**
 * Hedera side of the developer-wallet ledger (scripts/build-ledger.js). The developer wallets are the
 * project-controlled treasury accounts (walletFlowSenders.js); a "sent to exchange" event is a transfer from one
 * of them to a CEX-list account (ledger classify: cex_deposit). There is no swap decoding (WHBAR is a DEX venue
 * with no look-through), no bot cluster, and no USD value on token rows (the Solana branch values nothing either;
 * only stablecoins are separate assets, and HBAR has none configured).
 *
 * Incremental like the Solana branch: one "until" cursor per stream of contiguous accounts, a per-run time budget, a chain that does
 * not finish reports "partial" in coverage and resumes next run. The stored events are the classified ledger
 * rows (merged by uniqueId); the cursors say how far each account was read.
 */
import { stampOfNanos, tinybarToHbar } from "./walletFlowsHedera.js";
import { nanosOf } from "./flowScan.js";
import { scanSenderFlows } from "./walletFlowScan.js";
import { scanHash } from "./walletFlowSenders.js";

const SECONDS_PER_DAY = 86_400;
const NANOS_PER_SECOND = 1_000_000_000n;
const UNPAIRED = "unpaired";
const TOKEN_ASSET = "token";

/** Ledger transfers (classifyTransfer input) of raw scan events; an inbound transfer from another sender is that sender's own outbound event. */
export function ledgerTransfers(events, { chain, symbol, senders }) {
  const isSender = new Set(senders);
  const out = [];
  for (const e of events) {
    const inbound = e.dir === "in";
    if (inbound && isSender.has(e.d)) continue;
    const other = e.d === UNPAIRED ? null : e.d;
    out.push({
      chain,
      hash: e.sig,
      uniqueId: `${e.sig}:${inbound ? "in" : "out"}:${e.w}:${e.d}:${e.raw}`,
      time: e.t,
      from: inbound ? other : e.w,
      to: inbound ? e.w : other,
      contract: "HBAR",
      asset: TOKEN_ASSET,
      symbol,
      amount: tinybarToHbar(e.raw),
      swap: false,
    });
  }
  return out;
}

/** Cursors to resume from, or none when the checkpoint was made for another sender set or classifier. */
export function planLedgerResume({ checkpoint, hash, floor }) {
  if (!checkpoint?.accounts || checkpoint.hash !== hash) return { cursors: {}, rebuilt: Boolean(checkpoint?.accounts) };
  const floorNanos = nanosOf(floor);
  return {
    cursors: Object.fromEntries(Object.entries(checkpoint.accounts).map(([id, c]) => [id, nanosOf(c.until) < floorNanos ? { until: floor } : c])),
    rebuilt: false,
  };
}

/**
 * @returns {Promise<{ transfers: object[], cursor: object, stats: object, rebuilt: boolean, complete: boolean, failed: object[] }>}
 */
export async function scanHederaLedger({ client, chain, symbol, senders, classifierVersion, checkpoint, through, nowSec, historyDays, deadlineMs, logger = console, now = Date.now }) {
  const hash = scanHash(senders, classifierVersion);
  const floor = stampOfNanos(nanosOf(through) - BigInt(historyDays * SECONDS_PER_DAY) * NANOS_PER_SECOND);
  const { cursors, rebuilt } = planLedgerResume({ checkpoint, hash, floor });
  const res = await scanSenderFlows({ client, senders, cursors, start: floor, through, deadlineMs, inbound: true, logger, now });
  const behind = res.streams.filter((k) => nanosOf(res.cursors[k].until) < nanosOf(through));
  return {
    transfers: ledgerTransfers(res.events, { chain, symbol, senders }),
    cursor: { hash, accounts: res.cursors, through, headTime: new Date(nowSec * 1000).toISOString(), backlog: behind.length },
    stats: { ...res.stats, transfers: res.events.length, streams: res.streams.length, streamsBehind: behind.length },
    rebuilt,
    complete: behind.length === 0 && res.failed.length === 0,
    failed: res.failed,
  };
}
