/**
 * Incremental scan state for the EVM gated wallet-flows report
 * (scripts/generate-wallet-flows.js). Pure and RPC-free.
 *
 * State file (next to the report, `<work>/forensics/wallet-flows-evm-state.json`):
 *   { version, configHash, chains: { <chain>: { cursor, events: [...] } } }
 * `cursor` = last block scanned; `events` = decoded outflow transfers of the watched
 * senders, pruned to the 90-day start block. The Solana generator keeps its own
 * `wallet-flows-state.json`; a mixed project has both, hence the distinct name.
 */
import { createHash } from "node:crypto";
import { DEFAULT_CONFIRMATIONS, confirmationsFor } from "./logSource.js";

export const WALLET_FLOWS_EVM_STATE_FILE = "forensics/wallet-flows-evm-state.json";
export const STATE_VERSION = 1;

/** Raw token-related chain config (never resolved, so a chain we do not scan cannot throw). */
export const tokenConfigFingerprint = (chainsCfg) =>
  Object.keys(chainsCfg ?? {})
    .sort()
    .map((c) => {
      const { tokens, tokenAddress, decimals, contracts } = chainsCfg[c] ?? {};
      return [c, { tokens, tokenAddress, decimals, contracts }];
    });
/** Bump when classification / swap-marking rules change in a way the hashed inputs do not capture. */
export const STATE_LOGIC_VERSION = 1;

/** Blocks re-read behind the cursor: the chain's confirmation depth (deepest known depth for unlisted chains). */
export function overlapFor(chain) {
  try {
    return confirmationsFor(chain);
  } catch {
    return Math.max(...Object.values(DEFAULT_CONFIRMATIONS));
  }
}

/** Code-side inputs of the config hash (not source text). */
export const stateLogic = ({ swapTopics, minCandidateTel }) => ({
  version: STATE_LOGIC_VERSION,
  swapTopics: [...swapTopics.keys()].sort(),
  minCandidateTel,
});

/** Key-order independent JSON, so the hash does not depend on object construction order. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash of everything that decides which events are stored and how they are labelled. */
export const configHash = (config) => createHash("sha256").update(stable(config)).digest("hex");

export const eventKey = (e) => `${e.tx}:${e.logIndex}`;

/**
 * Decide the scan range for one chain.
 * @returns {{ full: boolean, from: number, reason?: string, events: object[] }}
 *   `events` are the stored events to keep (empty on a full scan).
 */
export function planChainScan({ state, chain, hash, start90, head, overlap = overlapFor(chain) }) {
  const full = (reason) => ({ full: true, from: start90, reason, events: [] });
  if (!state || typeof state !== "object") return full("no state");
  if (state.version !== STATE_VERSION) return full("state version changed");
  if (state.configHash !== hash) return full("registry or token config changed");
  const entry = state.chains?.[chain];
  if (!entry || !Number.isInteger(entry.cursor) || !Array.isArray(entry.events)) return full("no cursor for chain");
  if (entry.cursor < start90) return full("cursor older than 90d");
  if (entry.cursor > head) return full("cursor ahead of head");
  const from = Math.max(start90, entry.cursor + 1 - overlap);
  return { full: false, from, events: entry.events };
}

/**
 * Keep stored events before `from`, replace everything at or after it with the fresh
 * scan (dedupe by tx + logIndex), prune below `start90`.
 */
export function mergeEvents(stored, fresh, { from, start90 }) {
  const out = new Map();
  const carried = new Map();
  for (const e of stored) {
    if (e.block < from && e.block >= start90) out.set(eventKey(e), e);
    const { swapped, swapCheck, swapAttempts } = e;
    carried.set(eventKey(e), { swapped, swapCheck, swapAttempts });
  }
  for (const e of fresh) {
    if (e.block < start90) continue;
    const prior = carried.get(eventKey(e));
    // Carry settled verdicts (true/false/gave-up) and the retry counter onto the re-read copy.
    const keep = prior && (prior.swapped === true || prior.swapped === false || prior.swapAttempts) ? prior : null;
    const merged = keep ? { ...e, ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)) } : e;
    out.set(eventKey(e), merged);
  }
  return [...out.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/**
 * One chain's resumable outflow scan: plan, then fetch `[plan.from, head]` in segments of
 * `segmentBlocks`, merging (carrying stored swap verdicts) and calling `onProgress(entry)` after
 * every segment so a deadline or a kill loses at most one segment. Invariant of every saved
 * entry: `events` is complete for `[start90, cursor]` (stored events beyond the cursor are
 * dropped; the resumed run re-reads them). Once the head is reached, swaps are marked on the
 * merged store (null/absent verdicts are retried) and the final entry is saved.
 *
 * A segment is never started after `deadlineMs`. Then `complete` is false and `entry` is the last
 * saved entry (null when nothing was scanned: the caller keeps the previous state). A fetch
 * error throws, leaving the last saved entry in place.
 * @returns {Promise<{ plan: object, fresh: object[], events: object[], entry: object|null, complete: boolean }>}
 */
export async function scanChainOutflows({
  state,
  chain,
  hash,
  start90,
  head,
  scan,
  mark,
  segmentBlocks = Infinity,
  deadlineMs = Infinity,
  now = Date.now,
  onProgress = null,
}) {
  const plan = planChainScan({ state, chain, hash, start90, head });
  const fresh = [];
  let entry = null;
  let scannedTo = plan.from - 1;
  while (scannedTo < head) {
    if (now() >= deadlineMs) {
      return { plan, fresh, events: entry?.events ?? [], entry, complete: false };
    }
    const to = Math.min(head, scannedTo + segmentBlocks);
    fresh.push(...(await scan(scannedTo + 1, to)));
    scannedTo = to;
    if (scannedTo < head) {
      entry = { cursor: scannedTo, events: mergeEvents(plan.events, fresh, { from: plan.from, start90 }) };
      await onProgress?.(entry);
    }
  }
  const events = mergeEvents(plan.events, fresh, { from: plan.from, start90 });
  await mark(events);
  entry = { cursor: head, events };
  await onProgress?.(entry);
  return { plan, fresh, events, entry, complete: true };
}

/**
 * Next state. Chains not scanned this run keep their entry from `previous`, but only
 * when `previous` was built under the same version and config hash and, if given,
 * the chain is in `validChains` (chains removed from config are dropped).
 */
export function buildState({ hash, chains, previous, validChains }) {
  const prior = previous?.version === STATE_VERSION && previous.configHash === hash ? previous.chains ?? {} : {};
  const reusable = validChains ? Object.fromEntries(Object.entries(prior).filter(([c]) => validChains.includes(c))) : prior;
  return { version: STATE_VERSION, configHash: hash, chains: { ...reusable, ...chains } };
}
