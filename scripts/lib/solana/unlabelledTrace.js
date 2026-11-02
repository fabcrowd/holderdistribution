/**
 * Pure 90-day view of token transfers into unlabelled destinations: how much
 * arrived at each, where it went next, and how much is still unaccounted for.
 * No I/O.
 *
 * Addresses are base58 and case-sensitive: destinations are grouped by their
 * exact string, so case variants stay separate.
 */
import { WINDOW_SECONDS } from "../walletFlows.js";
import {
  compareHops,
  isSameOrChildRef,
  labelsByAddress,
  shortAddress,
  toIso,
  toUiAmount,
} from "./salesJournal.js";

const WINDOW = "90d";
const UNLABELLED = "unlabelled";
const TRACE_TASK = "trace";
const UNACCOUNTED = "unaccounted";

const eventRef = (e) => `${e.sig}|${e.wallet}|${e.dest}`;
const groupKey = (wallet, dest) => `${wallet}|${dest}`;

function groupByDestination(events) {
  const groups = new Map();
  for (const e of events) {
    const key = groupKey(e.wallet, e.dest);
    const group = groups.get(key) ?? { wallet: e.wallet, dest: e.dest, raw: 0n, t: e.t, refs: [] };
    group.raw += BigInt(e.raw);
    group.t = Math.max(group.t, e.t);
    group.refs.push(eventRef(e));
    groups.set(key, group);
  }
  return groups;
}

/** Largest received first; ties broken by exact key string. */
function compareGroups(a, b) {
  if (a.raw !== b.raw) return a.raw > b.raw ? -1 : 1;
  const keyA = groupKey(a.wallet, a.dest);
  const keyB = groupKey(b.wallet, b.dest);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/** Status of the shallowest matching trace task; "untracked" when none matches. */
function traceStatus(traces) {
  if (traces.length === 0) return "untracked";
  return traces.reduce((best, t) => (t.depth < best.depth ? t : best)).status;
}

/**
 * Keeps raw BigInt sums next to the public row so totals stay exact.
 * Unaccounted is floored at zero, so the identity only holds when onward hops
 * do not exceed what arrived.
 */
function analyseDestination(group, ctx) {
  const traces = ctx.tasks.filter((t) => group.refs.some((ref) => isSameOrChildRef(t.ref, ref)));
  const traceIds = new Set(traces.map((t) => t.id));
  const onward = ctx.hops.filter((h) => traceIds.has(h.taskId)).sort(compareHops);
  const kindRaw = new Map();
  let onwardRaw = 0n;
  for (const hop of onward) {
    // Deeper hops move funds already counted by the first hop that led to them.
    if (hop.depth > 1) continue;
    const raw = BigInt(hop.raw);
    onwardRaw += raw;
    kindRaw.set(hop.kind, (kindRaw.get(hop.kind) ?? 0n) + raw);
  }
  const unaccountedRaw = group.raw > onwardRaw ? group.raw - onwardRaw : 0n;
  const received = toUiAmount(group.raw, ctx.decimals);
  return {
    raw: group.raw,
    unaccountedRaw,
    kindRaw,
    row: {
      wallet: group.wallet,
      label: ctx.labels.get(group.wallet) ?? shortAddress(group.wallet),
      dest: group.dest,
      received,
      receivedUsd: ctx.priceUsd > 0 ? received * ctx.priceUsd : null,
      t: toIso(group.t),
      status: traceStatus(traces),
      onward: onward.map((hop) => ({
        hop: hop.depth,
        from: hop.from,
        to: hop.to,
        kind: hop.kind,
        venue: hop.venue,
        mint: hop.mint,
        amount: toUiAmount(hop.raw, ctx.decimals),
        sig: hop.sig,
        t: toIso(hop.t),
      })),
      byKind: Object.fromEntries([...kindRaw].map(([kind, raw]) => [kind, toUiAmount(raw, ctx.decimals)])),
      unaccounted: toUiAmount(unaccountedRaw, ctx.decimals),
    },
  };
}

function totalsOf(analysed, decimals, priceUsd) {
  const received = analysed.reduce((sum, a) => sum + a.raw, 0n);
  const byKind = new Map();
  let unaccounted = 0n;
  for (const a of analysed) {
    unaccounted += a.unaccountedRaw;
    for (const [kind, raw] of a.kindRaw) byKind.set(kind, (byKind.get(kind) ?? 0n) + raw);
  }
  const receivedUi = toUiAmount(received, decimals);
  return {
    received: receivedUi,
    receivedUsd: priceUsd > 0 ? receivedUi * priceUsd : null,
    byKind: {
      ...Object.fromEntries([...byKind].map(([kind, raw]) => [kind, toUiAmount(raw, decimals)])),
      [UNACCOUNTED]: toUiAmount(unaccounted, decimals),
    },
  };
}

/**
 * Unlabelled destinations inside the 90-day window, largest first. Totals cover
 * every destination; `destinations` is capped at `limit`.
 * @returns {object | null} null when no unlabelled event falls in the window
 */
export function buildUnlabelledTrace({ events, follow, registry, nowSec, decimals, priceUsd = 0, limit = 25 }) {
  const floor = nowSec - WINDOW_SECONDS[WINDOW];
  const recent = events.filter((e) => e.kind === UNLABELLED && e.t >= floor);
  if (recent.length === 0) return null;
  const ctx = {
    tasks: Object.values(follow?.tasks ?? {}).filter((t) => t.kind === TRACE_TASK),
    hops: follow?.hops ?? [],
    labels: labelsByAddress(registry),
    decimals,
    priceUsd,
  };
  const analysed = [...groupByDestination(recent).values()]
    .sort(compareGroups)
    .map((group) => analyseDestination(group, ctx));
  return {
    window: WINDOW,
    totals: totalsOf(analysed, decimals, priceUsd),
    destinations: analysed.slice(0, limit).map((a) => a.row),
  };
}
