/**
 * Pure helpers of the Hedera gated wallet-flows report (scripts/generate-wallet-flows-hedera.js): scan state,
 * labelling of stored raw sender events with the CURRENT venue lists, rows and notes. No network.
 */
import { destinationKind, rawToUnits } from "../solana/walletFlowsSolana.js";
import { nanosOf } from "./flowScan.js";

const HBAR_DECIMALS = 8;

export const WALLET_STATE_VERSION = 1;
export const WINDOW_DAYS = 90;
const SECONDS_PER_DAY = 86_400;
const NANOS_PER_SECOND = 1_000_000_000n;
const HASHSCAN_TX = "https://hashscan.io/mainnet/transaction/";
const DEFAULT_SAMPLE_LIMIT = 4;

/** "seconds.nanos" of a nanosecond count. */
export function stampOfNanos(n) {
  const s = n / NANOS_PER_SECOND;
  return `${s}.${String(n % NANOS_PER_SECOND).padStart(9, "0")}`;
}

/** The consensus stamp 90 days before `through`: a new sender's scan starts after it. */
export const windowStart = (through) => stampOfNanos(nanosOf(through) - BigInt(WINDOW_DAYS * SECONDS_PER_DAY) * NANOS_PER_SECOND);

export const eventKey = (e) => `${e.sig}|${e.dir ?? "out"}|${e.w}|${e.d}|${e.raw}`;

export const emptyState = ({ hash, key }) => ({ version: WALLET_STATE_VERSION, hash, key, through: null, throughDate: null, cursors: {}, events: [], complete: false });

/**
 * What to do with a stored state: keep it, or rebuild because it was made for another sender set, scan version
 * or chain key. `reason` says why. Cursors (one per stream of contiguous sender ids) older than the window floor restart at the floor.
 */
export function planResume({ state, hash, key, floor }) {
  const fresh = (reason) => ({ state: emptyState({ hash, key }), rebuilt: true, reason });
  if (!state || typeof state !== "object") return fresh("no state");
  if (state.version !== WALLET_STATE_VERSION) return fresh("state version changed");
  if (state.hash !== hash) return fresh("sender set or scan version changed");
  if (state.key !== key) return fresh("chain key changed");
  if (!Array.isArray(state.events) || typeof state.cursors !== "object" || state.cursors === null) return fresh("state unreadable");
  const floorNanos = nanosOf(floor);
  const cursors = Object.fromEntries(
    Object.entries(state.cursors).map(([id, c]) => [id, nanosOf(c.until) < floorNanos ? { until: floor } : c]),
  );
  return { state: { ...state, cursors }, rebuilt: false, reason: null };
}

/** The state is resumable only if every cursor lies inside the window it was scanned for. */
export function isResumable(state, { floor, through }) {
  if (!Array.isArray(state?.events) || typeof state?.cursors !== "object" || state.cursors === null) return false;
  return Object.values(state.cursors).every((c) => c && typeof c.until === "string" && nanosOf(c.until) >= nanosOf(floor) && nanosOf(c.until) <= nanosOf(through));
}

/**
 * Runs `scan`; if it throws (an invariant violation, an unreadable page), saves the newest in-memory state first when
 * it is resumable, then rethrows. `snapshot()` is only updated after a page is fully merged with its cursors, so it
 * always holds events complete for [start, cursor] of every stream; a page being read when the error hit is not in it.
 */
export async function scanSavingStateOnError({ scan, snapshot, persist, window, logger = console }) {
  try {
    return await scan();
  } catch (error) {
    const state = snapshot();
    if (isResumable(state, window)) {
      try {
        await persist(state);
        logger.error("hedera wallet-flows: scan error; state saved at its last consistent cursors");
      } catch (saveError) {
        logger.error(`hedera wallet-flows: scan error and the state could not be saved (${saveError?.message ?? saveError})`);
      }
    }
    throw error;
  }
}

/** Merges events into the state once each (an event re-delivered after a crash between store and cursor is dropped). */
export function mergeEvents(state, events) {
  const seen = new Set(state.events.map(eventKey));
  const added = [];
  for (const e of events) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(e);
  }
  return { ...state, events: [...state.events, ...added] };
}

/** Drops events at or before the window floor. */
export function pruneEvents(events, anchorSec) {
  const floor = anchorSec - WINDOW_DAYS * SECONDS_PER_DAY;
  return events.filter((e) => e.t > floor);
}

/**
 * Labels raw events by recipient with the current lists, in the shape aggregateWalletOutflows expects.
 * Check order (walletFlowsSolana.destinationKind): CEX, DEX, staking, internal, unlabelled.
 * @param {{ wallets: Set<string>, cex: Map<string,string>, dex: Set<string>, staking: Set<string> }} roles
 */
export function labelEvents(events, roles) {
  return events.map((e) => {
    const kind = destinationKind(e.d, roles);
    const registryLabel = kind.kind === "internal" ? roles.labels?.get(e.d) : undefined;
    return { wallet: e.w, dest: e.d, ...kind, venue: registryLabel ?? kind.venue, raw: e.raw, t: e.t, sig: e.sig };
  });
}

const OUTFLOW_KINDS = ["CEX", "DEX", "staking", "internal", "unlabelled"];

/**
 * Exact tinybar check before any conversion to HBAR: every labelled event has one of the known kinds, so
 * CEX + DEX + staking + internal + unlabelled equals the total outflow. Returns the BigInt totals.
 */
export function outflowTotals(labelled) {
  const byKind = Object.fromEntries(OUTFLOW_KINDS.map((k) => [k, 0n]));
  let total = 0n;
  for (const e of labelled) {
    total += BigInt(e.raw);
    if (!Object.hasOwn(byKind, e.kind)) throw new Error(`hedera wallet-flows: event ${e.sig} has the unknown outflow kind ${JSON.stringify(e.kind)}`);
    byKind[e.kind] += BigInt(e.raw);
  }
  const parts = OUTFLOW_KINDS.reduce((s, k) => s + byKind[k], 0n);
  if (parts !== total) throw new Error(`hedera wallet-flows: outflow kinds sum to ${parts} tinybar but the events total ${total}`);
  return { total, byKind };
}

/** Tinybar as HBAR, converted once from the exact decimal string (the double nearest the true value). */
export const tinybarToHbar = (raw) => rawToUnits(raw, HBAR_DECIMALS);

/** Largest sell-venue transactions per wallet inside the window, as HashScan links (consensus stamp). */
export function hederaSampleTxs(labelled, anchorSec, limit = DEFAULT_SAMPLE_LIMIT) {
  const floor = anchorSec - WINDOW_DAYS * SECONDS_PER_DAY;
  const byWallet = new Map();
  for (const e of labelled) {
    if (e.t <= floor || (e.kind !== "CEX" && e.kind !== "DEX")) continue;
    (byWallet.get(e.wallet) ?? byWallet.set(e.wallet, []).get(e.wallet)).push(e);
  }
  const out = new Map();
  for (const [wallet, list] of byWallet) {
    const urls = [...list]
      .sort((a, b) => (BigInt(a.raw) === BigInt(b.raw) ? 0 : BigInt(a.raw) > BigInt(b.raw) ? -1 : 1))
      .slice(0, limit)
      .map((e) => `${HASHSCAN_TX}${e.sig}`);
    out.set(wallet, urls);
  }
  return out;
}

export const HEDERA_REPORT_NOTES = (notTraced, omitted, anchorIso) => [
  `Hedera outflows are first-hop HBAR transfers sent by the project-controlled treasury accounts, classified by recipient (exchange list, DEX/wrapped HBAR, another treasury account, or unlabelled). Windows end at the settled day end ${anchorIso}.`,
  ...(notTraced.length > 0 ? [`Treasury accounts that are not traced (they stay treasury for supply): ${notTraced.map((a) => `${a.address} (${a.reason})`).join(" ")}`] : []),
  "Onward hops from unlabelled recipients are not traced for Hedera. Wrapped HBAR (WHBAR) is counted as DEX with no look-through to its holders.",
  "Fees are not flows, staking-reward legs are removed, and a failed transaction moves nothing but its fee. In a transaction with several senders and recipients, transfers are paired largest to largest.",
  ...(omitted > 0 ? [`${omitted} registry treasury accounts hold no HBAR and sent nothing in the window; they are left out of the table.`] : []),
];
