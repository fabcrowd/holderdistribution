/**
 * Block-based day cutoffs.
 *
 * Convention: cutoff[chain][D] = first block (Solana: first produced slot)
 * whose timestamp >= D 00:00:00Z. The settled end of day D-1 is the state at
 * block cutoff[D] - 1.
 *
 * Two older conventions exist in the repo and are NOT this one:
 *   - public/data[/<slug>]/date-blocks.json {chain:{D:block}} (rebuild-history-from-logs):
 *     last block with timestamp <= D 00:00:00Z (historicalReplay.findBlockAtTime).
 *   - data[/<slug>]/holders-asof-blocks.json {D:{chain:block}} (fill-history-gaps):
 *     last block with timestamp <= D 23:59:59Z.
 * The converters below map both onto cutoffs. The 23:59:59Z one is exact
 * (timestamps are whole seconds, so "<= D 23:59:59" == "< D+1 00:00:00").
 * The midnight one is exact except when a block lands on 00:00:00 exactly
 * (then cutoff == that block, not block + 1); a block timestamp is needed to
 * tell, so that converter is an approximation.
 *
 * The cutoff map is stored in the existing date-blocks.json under CUTOFF_KEY so
 * the legacy chain-keyed entries other scripts read stay untouched.
 *
 * Everything RPC-shaped is injected; nothing here talks to a node.
 */
import fs from "node:fs";
import path from "node:path";

export const CUTOFF_KEY = "cutoffs";
export const DATE_BLOCKS_FILE = "date-blocks.json";
const DAY_MS = 86_400_000;

export const midnightSeconds = (date) => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(ms)) throw new Error(`bad date ${JSON.stringify(date)}`);
  return ms / 1000;
};

export const nextDate = (date) => new Date(midnightSeconds(date) * 1000 + DAY_MS).toISOString().slice(0, 10);

/**
 * First block in [lo, hi] whose timestamp >= targetSeconds, or null when even
 * block `hi` is older than the target. Assumes timestamps are non-decreasing.
 */
export async function findFirstBlockAtOrAfter(targetSeconds, getBlockTimestamp, lo, hi) {
  if (lo > hi) return null;
  if ((await getBlockTimestamp(hi)) < targetSeconds) return null;
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if ((await getBlockTimestamp(mid)) >= targetSeconds) b = mid;
    else a = mid + 1;
  }
  return a;
}

const SKIPPED_SLOT_CODES = new Set([-32007, -32009]);
const SKIPPED_SLOT_MESSAGE = /slot \d+ was skipped, or missing due to ledger jump to recent snapshot/i;
// Pruned / unavailable history; never a skipped slot even if the text also says "was skipped".
const PRUNED_MESSAGE = /long-term storage|cleaned up|purged|not available/i;

// "Slot N was skipped, or missing in long-term storage": nodes (Helius,
// api.mainnet) return it for a skipped slot AND for history they no longer
// hold, so the message alone proves nothing; getBlocks decides (see below).
const LONG_TERM_SKIPPED_MESSAGE = /^slot (\d+) was skipped, or missing in long-term storage$/i;

/** True only for the node's precise skipped-slot error (code -32007/-32009 when the error carries one). */
export const isSkippedSlotError = (e) => {
  const msg = String(e?.message ?? "");
  if (e?.code != null && !SKIPPED_SLOT_CODES.has(Number(e.code))) return false;
  return SKIPPED_SLOT_MESSAGE.test(msg) && !PRUNED_MESSAGE.test(msg);
};

/** True for the ambiguous long-term-storage skipped-slot error (code -32007/-32009 when present). */
export const isAmbiguousSkipError = (e) => {
  if (e?.code != null && !SKIPPED_SLOT_CODES.has(Number(e.code))) return false;
  return LONG_TERM_SKIPPED_MESSAGE.test(String(e?.message ?? "").trim());
};

/**
 * Wraps a Solana RPC `call(method, params)` into the `getBlockTime` shape
 * findFirstSlotAtOrAfter expects. A null is returned only when the slot is
 * provably unproduced:
 *   - the precise "…missing due to ledger jump to recent snapshot" error, or
 *   - the ambiguous "…missing in long-term storage" error AND getBlocks(slot,
 *     slot) lists nothing, or lists it but the node can't serve it (stepped
 *     over with a warning; the capped walk bounds the shift to a few slots).
 * All other errors (429, timeout, "Block not available", purged) and a slot
 * above `head` throw.
 */
export const solanaBlockTimeOrNull = (call, head = null) => async (slot) => {
  if (Number.isInteger(head) && slot > head) throw new Error(`getBlockTime(${slot}): slot is above the head ${head}`);
  try {
    return await call("getBlockTime", [slot]);
  } catch (e) {
    if (isSkippedSlotError(e)) return null;
    if (!isAmbiguousSkipError(e)) throw e;
    const produced = await call("getBlocks", [slot, slot]);
    if (!Array.isArray(produced)) throw new Error(`getBlocks(${slot}) returned no list; cannot tell a skipped slot from a retention gap: ${e.message}`);
    if (produced.length === 0) return null;
    // A produced block this node can't serve: step over it like a skip. The
    // walk is capped (maxWalk), so the cutoff moves by a few slots at most,
    // which is far better than failing the day's cutoff entirely.
    console.warn(`  solana slot ${slot}: produced but not served by this node; stepping over it`);
    return null;
  }
};

export const SOLANA_SLOTS_PER_DAY = 216_000; // 400 ms target slot time
export const SOLANA_SEARCH_MARGIN = 1.5;

/**
 * Lowest slot a cutoff search for dates up to `daysBack` days before head
 * needs: head - (daysBack + 2) days of slots, with margin. Keeps the search
 * off pruned history. findFirstSlotAtOrAfter throws if it turns out too high.
 */
export const solanaSearchLow = (head, daysBack) =>
  Math.max(0, head - Math.ceil((Math.max(daysBack, 0) + 2) * SOLANA_SLOTS_PER_DAY * SOLANA_SEARCH_MARGIN));

export const SLOT_TIME_RETRIES = 3;
export const MAX_SKIPPED_SLOT_WALK = 200;

/**
 * Solana equivalent over slots. `getBlockTime(slot)` returns unix seconds, or
 * null for a skipped (unproduced) slot. A thrown error is NOT a skipped slot
 * (429, pruned ledger, timeout): it is retried `retries` times and then
 * re-thrown, so a guess is never returned (and never persisted). The walk over
 * consecutive skipped slots is capped at `maxWalk`; exceeding it throws.
 * Returns the first PRODUCED slot in [lo, hi] with time >= targetSeconds, or null.
 */
export async function findFirstSlotAtOrAfter(targetSeconds, getBlockTime, lo, hi, { retries = SLOT_TIME_RETRIES, maxWalk = MAX_SKIPPED_SLOT_WALK } = {}) {
  const timeOf = async (slot) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const t = await getBlockTime(slot);
        return t == null ? null : Number(t);
      } catch (e) {
        if (attempt >= retries) throw new Error(`getBlockTime(${slot}) failed after ${retries + 1} attempts: ${e?.message ?? e}`);
      }
    }
  };
  // Nearest produced slot at or after `slot` (bounded by hi and maxWalk).
  const produced = async (slot) => {
    for (let s = slot; s <= hi; s += 1) {
      if (s - slot >= maxWalk) throw new Error(`no produced slot within ${maxWalk} slots of ${slot}`);
      const t = await timeOf(s);
      if (t != null) return { slot: s, t };
    }
    return null;
  };
  let a = lo;
  let b = hi;
  let best = null;
  while (a <= b) {
    const mid = Math.floor((a + b) / 2);
    const p = await produced(mid);
    if (!p || p.slot > b) {
      b = mid - 1;
      continue;
    }
    if (p.t >= targetSeconds) {
      best = p.slot;
      b = mid - 1;
    } else {
      a = p.slot + 1;
    }
  }
  // With a floor above genesis, a hit on the first produced slot at/after lo
  // cannot be told apart from "the target is below the floor".
  if (best != null && lo > 0) {
    const floor = await produced(lo);
    if (floor && floor.slot === best) throw new Error(`search floor ${lo} is already at/after the target ${targetSeconds}; widen the window`);
  }
  return best;
}

/** cutoff[D+1] = lastBlockOf(D) + 1, from holders-asof-blocks.json {D:{chain:n}}. */
export function cutoffsFromEndOfDayMap(asOfMap) {
  const out = {};
  for (const [date, chains] of Object.entries(asOfMap ?? {})) {
    const d = nextDate(date);
    for (const [chain, block] of Object.entries(chains ?? {})) {
      if (!Number.isInteger(block)) continue;
      (out[chain] ??= {})[d] = block + 1;
    }
  }
  return out;
}

/** Inverse of cutoffsFromEndOfDayMap for `dates`: {D:{chain: cutoff[D+1]-1}} (only resolved chains). */
export function endOfDayMapFromCutoffs(cutoffs, dates) {
  const out = {};
  for (const date of dates) {
    for (const [chain, m] of Object.entries(cutoffs ?? {})) {
      const c = m?.[nextDate(date)];
      if (Number.isInteger(c)) (out[date] ??= {})[chain] = c - 1;
    }
  }
  return out;
}

/** a with every entry of b it lacks (a wins on conflict). */
export function mergeCutoffMaps(a, b) {
  const out = Object.fromEntries(Object.entries(a ?? {}).map(([c, m]) => [c, { ...m }]));
  for (const [chain, m] of Object.entries(b ?? {})) {
    for (const [d, block] of Object.entries(m ?? {})) if ((out[chain] ??= {})[d] == null) out[chain][d] = block;
  }
  return out;
}

export const cutoffMapPath = (project, root = process.cwd()) => path.resolve(root, project.dataDir, DATE_BLOCKS_FILE);

const defaultIo = {
  read: (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}),
  write: (p, obj) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  },
};

/** Same reads as the default io, writes dropped (dry runs). */
export const readOnlyIo = { read: defaultIo.read, write: () => {} };

/** {chain:{D:cutoffBlock}} for a project ({} when absent). */
export function readCutoffMap(project, { root, io = defaultIo } = {}) {
  return io.read(cutoffMapPath(project, root))?.[CUTOFF_KEY] ?? {};
}

/** Writes the cutoff map, keeping every other key of date-blocks.json. Dates sorted. */
export function writeCutoffMap(project, map, { root, io = defaultIo } = {}) {
  const p = cutoffMapPath(project, root);
  const file = io.read(p) ?? {};
  const sorted = Object.fromEntries(
    Object.keys(map).sort().map((chain) => [chain, Object.fromEntries(Object.keys(map[chain]).sort().map((d) => [d, map[chain][d]]))]),
  );
  io.write(p, { ...file, [CUTOFF_KEY]: sorted });
  return sorted;
}

/**
 * Resolves missing cutoffs for `dates` on every chain in `resolvers`
 * ({chain: async (targetSeconds) => block|null}). Existing entries are never
 * re-searched. Writes only when something was added. Returns the full map.
 */
export async function ensureCutoffs(project, dates, { resolvers, root, io = defaultIo } = {}) {
  const current = readCutoffMap(project, { root, io });
  const next = Object.fromEntries(Object.entries(current).map(([c, m]) => [c, { ...m }]));
  let added = 0;
  for (const [chain, resolve] of Object.entries(resolvers ?? {})) {
    for (const date of dates) {
      if (next[chain]?.[date] != null) continue;
      const block = await resolve(midnightSeconds(date));
      if (block == null) continue;
      (next[chain] ??= {})[date] = block;
      added += 1;
    }
  }
  return added ? writeCutoffMap(project, next, { root, io }) : current;
}

export const utcDate = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** Inclusive list of YYYY-MM-DD dates from `from` to `to` ([] when from > to). */
export function datesFromTo(from, to) {
  const out = [];
  for (let d = from; d <= to; d = nextDate(d)) out.push(d);
  return out;
}

/** UTC day D whose bucket [cutoff[D], cutoff[D+1]) holds `block`, or null when before every known cutoff. */
export function dateOfBlock(chainCutoffs, block) {
  let best = null;
  for (const [d, c] of Object.entries(chainCutoffs ?? {})) {
    if (c <= block && (best == null || d > best)) best = d;
  }
  return best;
}

/**
 * Ascending day boundaries [{block, date}] for `wanted` plus the exclusive end
 * edge cutoff[last wanted + 1]. Throws when any of them is unresolved: a gap
 * would silently bucket that day's transfers into the previous day.
 */
export function requireDayBounds(chain, chainCutoffs, wanted) {
  const edge = nextDate(wanted[wanted.length - 1]);
  const missing = [...wanted, edge].filter((d) => !Number.isInteger(chainCutoffs?.[d]));
  if (missing.length) throw new Error(`${chain}: unresolved day cutoffs ${missing.join(", ")}; refusing to bucket flows`);
  const bounds = wanted.map((d) => ({ block: chainCutoffs[d], date: d })).sort((a, b) => a.block - b.block);
  return { bounds, endBoundary: chainCutoffs[edge] };
}

/** Last block of the settled day before `today` (cutoff[today] - 1), or null when unknown. */
export const settledEndBlock = (chainCutoffs, today) =>
  Number.isInteger(chainCutoffs?.[today]) ? chainCutoffs[today] - 1 : null;

/**
 * Cutoff-aligned scan window for one chain of an incremental flow scan.
 * Resolves (and persists) missing cutoffs from the day of block `from` through
 * `today`, ends the scan at min(latest, cutoff[today]-1, from+maxBlocks-1) and
 * buckets blocks by the cutoff map. The vm adapter's clock picks the search (EVM blocks, Solana slots).
 * Returns { end, settledBlock, dateOf, cutoffs } (end < from = nothing to scan).
 */
export async function cutoffScanWindow({
  project, chain, from, latest, maxBlocks = Infinity, today = utcDate(), getBlockTimestamp, vm = "evm", root, io = defaultIo,
}) {
  // Lazy: chainAdapters imports this module, so a static import would be a cycle.
  const { loadChainAdapter } = await import("./chainAdapters.js");
  const first = (await loadChainAdapter(vm)).clock({ key: chain }).firstAtOrAfter;
  const fromTs = from <= latest ? await getBlockTimestamp(from) : null;
  const startDate = fromTs != null ? utcDate(Number(fromTs) * 1000) : today;
  const resolvers = { [chain]: (target) => first(target, getBlockTimestamp, 0, latest) };
  const wanted = datesFromTo(startDate < today ? startDate : today, today);
  const cutoffs = await ensureCutoffs(project, wanted, { resolvers, root, io });
  const chainCutoffs = cutoffs[chain] ?? {};
  const missing = wanted.filter((d) => !Number.isInteger(chainCutoffs[d]));
  if (missing.length) throw new Error(`${chain}: unresolved day cutoffs ${missing.join(", ")}; refusing to bucket flows`);
  const settledBlock = settledEndBlock(chainCutoffs, today);
  const end = settledBlock == null ? from - 1 : Math.min(latest, settledBlock, from + maxBlocks - 1);
  return { end, settledBlock, dateOf: (block) => dateOfBlock(chainCutoffs, block), cutoffs };
}

/** Feed `asOf` stamp: settled day before `today` and every chain's cutoff[today]-1 that is known. */
export function asOfFromCutoffs(cutoffs, today = utcDate()) {
  const blocks = {};
  for (const [chain, m] of Object.entries(cutoffs ?? {})) {
    const b = settledEndBlock(m, today);
    if (b != null) blocks[chain] = b;
  }
  return { date: utcDate(midnightSeconds(today) * 1000 - DAY_MS), blocks, settled: true };
}

const prevDate = (date) => utcDate(midnightSeconds(date) * 1000 - DAY_MS);

/**
 * Stamp for a Solana-only flow feed from scan-solana-flows' checkpoint
 * (chains.<key> = { complete, scanStartedAt }). A complete scan that started
 * on day S covered every day before S, so the stamp is asOfFromCutoffs as of
 * min(today, S) over `keys`. Any key incomplete, or without scanStartedAt, is
 * unknown coverage: { date: null, settled: false, incomplete } (no claim).
 */
export function asOfFromSolanaScan(cutoffs, scanState, keys, today = utcDate()) {
  const incomplete = keys.filter((k) => scanState?.[k]?.complete !== true || Number.isNaN(Date.parse(scanState[k].scanStartedAt ?? "")));
  if (incomplete.length) return { date: null, blocks: {}, settled: false, incomplete };
  const startDays = keys.map((k) => utcDate(Date.parse(scanState[k].scanStartedAt)));
  const asOfDay = [today, ...startDays].sort()[0];
  const wanted = new Set(keys);
  const stamp = asOfFromCutoffs(Object.fromEntries(Object.entries(cutoffs ?? {}).filter(([c]) => wanted.has(c))), asOfDay);
  // A missing slot is reported, not silently dropped (asOf.noBlock is informational).
  const noBlock = keys.filter((k) => stamp.blocks[k] == null);
  return noBlock.length ? { ...stamp, noBlock } : stamp;
}

/**
 * Resolves and persists a Solana chain's recent day cutoffs (first produced
 * slot >= D 00:00Z) into the project's date-blocks.json, same path EVM uses.
 * `call(method, params)` is the chain's RPC; `head` its finalized slot. Only the
 * last `days` days (not before `since`) are searched, with a bounded floor so
 * pruned history is never probed; older dates come from build-cutoffs.js.
 */
export async function ensureSolanaCutoffs(project, { key, call, head, since, days = 3, today = utcDate(), root, io = defaultIo }) {
  const dates = datesFromTo(utcDate(midnightSeconds(today) * 1000 - (days - 1) * DAY_MS), today).filter((d) => d >= since);
  const blockTime = solanaBlockTimeOrNull(call, head);
  const low = solanaSearchLow(head, days);
  return ensureCutoffs(project, dates, {
    resolvers: { [key]: (target) => findFirstSlotAtOrAfter(target, blockTime, low, head) },
    root,
    io,
  });
}

/**
 * Stamp for a flow feed (exchange flows, tier outflows): asOfFromReached over
 * the EVM chains' reached blocks; a Solana-only feed (no reached chains)
 * stamps from scan-solana-flows' checkpoint state via asOfFromSolanaScan.
 */
export function flowFeedAsOf(cutoffs, { reached = {}, scanState = null, solanaKeys = [] } = {}, today = utcDate()) {
  if (Object.keys(reached).length) return asOfFromReached(cutoffs, reached, today);
  return asOfFromSolanaScan(cutoffs, scanState, solanaKeys, today);
}

/** Last day D whose bucket [cutoff[D], cutoff[D+1]) is fully covered by a scan that reached `block`, or null. */
export function lastCompleteDate(chainCutoffs, block) {
  const d = dateOfBlock(chainCutoffs, block);
  if (d == null) return null;
  const next = chainCutoffs?.[nextDate(d)];
  return Number.isInteger(next) && block === next - 1 ? d : prevDate(d);
}

/**
 * Feed `asOf` stamp from the blocks a scan actually reached ({chain: lastBlock}).
 * Each chain's block is min(reached, cutoff[today]-1); `date` is the earliest
 * chain's last complete day, so a capped backlog scan never claims yesterday.
 */
export function asOfFromReached(cutoffs, reached, today = utcDate()) {
  const blocks = {};
  const dates = [];
  for (const [chain, r] of Object.entries(reached ?? {})) {
    if (!Number.isInteger(r)) continue;
    const settled = settledEndBlock(cutoffs?.[chain], today);
    const b = settled == null ? r : Math.min(r, settled);
    blocks[chain] = b;
    dates.push(lastCompleteDate(cutoffs?.[chain], b));
  }
  const date = dates.length && dates.every((d) => d != null) ? dates.sort()[0] : null;
  return { date, blocks, settled: date != null };
}
