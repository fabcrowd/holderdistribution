/**
 * The `asOf` stamp every published feed carries (see lib/dayBlocks.js for the
 * cutoff convention):
 *
 *   asOf: { date: "<YYYY-MM-DD>", blocks: { <chain>: <n> }, settled: <bool>,
 *           live?: [<chain>], unpinned?: [<chain>], noBlock?: [<chain>] }
 *
 *   date      the day the data describes. Settled: end of that day, i.e. the
 *             state at block cutoff[date + 1] - 1 on every chain.
 *   blocks    per-chain block (Solana: slot) the state was read at.
 *   settled   true only when every chain was read at its settled-day block.
 *   live      chains that cannot be read at a past block (Solana live scans):
 *             read at the run-time slot; `date` is then the run day.
 *   unpinned  EVM chains whose settled block could not be used this run
 *             (cutoff unresolved, or the checkpoint is already past it). A
 *             row built from such a snapshot is not emitted (shouldEmitRow).
 *   noBlock   chains with no block/slot recorded for `date` (informational).
 *
 * Pure; nothing here reads files or talks to a node.
 */
import { vmPinsToBlock, vmScansForwardFromCheckpoint } from "./chainVms.js";
import { midnightSeconds, nextDate } from "./dayBlocks.js";

const DAY_MS = 86_400_000;

export const utcDay = (now = new Date()) => new Date(now).toISOString().slice(0, 10);

/** The settled day a run targets: --as-of when given (must be before today UTC), else yesterday UTC. */
export function resolveSettledDate({ asOf = null, now = new Date() } = {}) {
  const today = utcDay(now);
  if (asOf != null) {
    midnightSeconds(asOf);
    if (asOf >= today) throw new Error(`--as-of ${asOf} is not a settled day (today UTC is ${today})`);
    return asOf;
  }
  return new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** Block holding the settled end of `settledDate` on `chain`: cutoff[date+1] - 1, or null. */
export function settledBlockFor(cutoffMap, chain, settledDate) {
  const cutoff = cutoffMap?.[chain]?.[nextDate(settledDate)];
  return Number.isInteger(cutoff) && cutoff > 0 ? cutoff - 1 : null;
}

/**
 * Settled stamp for `settledDate` from a cutoff map. `chains` defaults to the
 * map's own chains; requested chains without a cutoff land in noBlock.
 */
export function buildAsOf(settledDate, cutoffMap, { chains = Object.keys(cutoffMap ?? {}) } = {}) {
  midnightSeconds(settledDate);
  const blocks = {};
  const noBlock = [];
  for (const chain of chains) {
    const b = settledBlockFor(cutoffMap, chain, settledDate);
    if (b == null) noBlock.push(chain);
    else blocks[chain] = b;
  }
  return { date: settledDate, blocks, settled: true, ...(noBlock.length ? { noBlock } : {}) };
}

/**
 * Which block each chain of a live run is read at.
 * chains: [{ key, vm, checkpointBlock }] (checkpointBlock: last scanned block, or null).
 * Returns { pins: {key: block}, live: [non-EVM keys], unpinned: [EVM keys whose
 * cutoff is unresolved: read at head], ahead: [EVM keys whose checkpoint is
 * already past the settled block: see aheadAction] }.
 */
export function planPins({ chains, settledDate, cutoffMap }) {
  const pins = {};
  const live = [];
  const unpinned = [];
  const ahead = [];
  for (const { key, vm = "evm", checkpointBlock = null } of chains) {
    if (!vmPinsToBlock(vm)) {
      live.push(key);
      continue;
    }
    const block = settledBlockFor(cutoffMap, key, settledDate);
    if (block == null) unpinned.push(key);
    else if (vmScansForwardFromCheckpoint(vm) && Number.isInteger(checkpointBlock) && checkpointBlock > block) ahead.push(key);
    else pins[key] = block;
  }
  return { pins, live, unpinned, ahead };
}

/**
 * True when `history.entries` holds a row for `date` marked settled
 * (row.settled === true, written by generate-holders-history.js from a
 * settled snapshot, or row.asOf.settled === true). Legacy unmarked rows do not count.
 */
export const hasSettledRow = (history, date) =>
  (history?.entries ?? []).some((e) => e?.date === date && (e?.settled === true || e?.asOf?.settled === true));

/**
 * What a live run does when chains are `ahead` (checkpoint already past the
 * settled block, e.g. a second run the same day): "scan" when none are;
 * "noop" when the settled row for `settledDate` already exists (keep the
 * checkpoint and outputs unchanged); otherwise "unpin": the run still takes a
 * snapshot, scanning those chains to head and stamping them unpinned (no
 * settled row), and the nightly gap fill rebuilds the settled row with --as-of.
 * Failing the whole run here left the project with no snapshot at all.
 */
export function aheadAction({ ahead = [], settledDate, history }) {
  if (ahead.length === 0) return "scan";
  if (hasSettledRow(history, settledDate)) return "noop";
  return "unpin";
}

/**
 * Final stamp of a live run. `blocks` holds every chain's actual read block
 * (pins, plus slots / heads for live and unpinned chains when known).
 */
export function finalizeAsOf({ settledDate, runDay, blocks = {}, live = [], unpinned = [] }) {
  const settled = live.length === 0 && unpinned.length === 0;
  return {
    date: settled ? settledDate : runDay,
    blocks: { ...blocks },
    settled,
    ...(live.length ? { live: [...live] } : {}),
    ...(unpinned.length ? { unpinned: [...unpinned] } : {}),
  };
}

/** A daily row from a snapshot stamped with unpinned EVM chains is an intraday read: skip it. */
export const shouldEmitRow = (asOf) => !asOf || !(asOf.unpinned?.length > 0);

/** Copy of a source feed's stamp for a derived feed (null when the source has none). */
export const inheritAsOf = (source) =>
  source?.asOf ? { ...source.asOf, blocks: { ...(source.asOf.blocks ?? {}) } } : null;

/** Row date for a feed derived from `snapshot`: its asOf.date, else source.snapshotDate. */
export const rowDateOf = (snapshot) => snapshot?.asOf?.date ?? snapshot?.source?.snapshotDate ?? null;

/**
 * Top-level stamp of a feed after a run that produced `incoming`. It never
 * moves backwards: a gap fill (--as-of an older day) still upserts its row,
 * but the feed keeps the later existing stamp. A dated stamp outranks a
 * date-null one. Returns one of the inputs, or null when both are absent.
 */
export function mergeTopLevelAsOf(existing, incoming) {
  if (!incoming) return existing ?? null;
  if (!existing?.date) return incoming;
  if (!incoming.date) return existing;
  return incoming.date >= existing.date ? incoming : existing;
}
