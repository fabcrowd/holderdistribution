/**
 * Solana venue-flow scan. There is no Transfer-log range scan on Solana, so
 * flows are discovered per tracked venue (CEX / DEX owner):
 *
 *   getTokenAccountsByOwner(mint) -> getSignaturesForAddress (per token account,
 *   newest first, paged with `before`, stopped by `until` = the checkpoint) ->
 *   getTransaction (jsonParsed) -> per-owner mint deltas -> paired transfers ->
 *   classified events.
 *
 * Ordering and resume: signatures from every account are merged and processed
 * OLDEST FIRST in whole-slot steps, up to `maxTx` per run. Each account's
 * checkpoint (`until`) then advances to its newest processed signature, so the
 * rest is picked up by the next run and a transaction that touches two venue
 * accounts is attributed exactly once (dedup by signature).
 *
 * Owners are kept exactly as returned (base58 is case-sensitive).
 */
import { mintDeltasByOwner } from "./tokenFlows.js";
import { getTransactionAnyVersion } from "./getTransaction.js";

export const SIGNATURE_PAGE = 1000;
const MAX_PAGES = 500;
export const DEFAULT_CHUNK = 60;
// Newest unavailable signatures kept in the checkpoint; older ones are dropped
// so a long-pruned history cannot grow the checkpoint without bound.
export const UNAVAILABLE_CAP = 500;

export const bySlotThenSig = (a, b) => (a.slot !== b.slot ? a.slot - b.slot : a.signature < b.signature ? -1 : 1);

export const utcDay = (blockTime) => new Date(blockTime * 1000).toISOString().slice(0, 10);

/**
 * Pairs positive and negative owner deltas of one transaction into transfers
 * (largest against largest). Unpaired remainders are mint/burn legs
 * (from or to = null).
 * @param {Map<string, bigint>} deltas
 * @returns {Array<{from: string|null, to: string|null, raw: bigint}>}
 */
export function pairTransfers(deltas) {
  const byAmount = (x, y) => (x[1] === y[1] ? (x[0] < y[0] ? -1 : 1) : x[1] > y[1] ? -1 : 1);
  const gain = [...deltas].filter(([, v]) => v > 0n).sort(byAmount);
  const loss = [...deltas].filter(([, v]) => v < 0n).map(([k, v]) => [k, -v]).sort(byAmount);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < gain.length && j < loss.length) {
    const raw = gain[i][1] < loss[j][1] ? gain[i][1] : loss[j][1];
    out.push({ from: loss[j][0], to: gain[i][0], raw });
    gain[i][1] -= raw;
    loss[j][1] -= raw;
    if (gain[i][1] === 0n) i += 1;
    if (loss[j][1] === 0n) j += 1;
  }
  for (; i < gain.length; i += 1) out.push({ from: null, to: gain[i][0], raw: gain[i][1] });
  for (; j < loss.length; j += 1) out.push({ from: loss[j][0], to: null, raw: loss[j][1] });
  return out;
}

const keyOf = (k) => (typeof k === "string" ? k : k?.pubkey);

/**
 * Owners of token accounts listed in `addresses` (config may name a vault's
 * token account rather than its owner PDA). Only token accounts of `mint`
 * present in this transaction can resolve.
 */
export function ownersOfTokenAccounts(tx, mint, addresses) {
  const out = new Set();
  if (!addresses?.size) return out;
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  for (const b of [...(tx?.meta?.preTokenBalances ?? []), ...(tx?.meta?.postTokenBalances ?? [])]) {
    if (b.mint === mint && b.owner && addresses.has(keyOf(keys[b.accountIndex]))) out.add(b.owner);
  }
  return out;
}

/**
 * Classifies paired transfers. `roles`: { cex: Map<owner, exchange name>,
 * dex: Set<owner>, staking: Set<owner|token account> }.
 *
 *   staking  either side is a staking/reward vault (stake, unstake, reward
 *            payout): classified, NOT an exchange flow
 *   internal CEX -> CEX (never counted in net)
 *   cexIn / cexOut     custody flow against the exchange named `exchange`
 *   dexIn / dexOut     pool flow (counterparty is not a CEX)
 * `counterparty` is the other side (null = mint/burn leg).
 */
export function classifyTransfers(transfers, roles, tx = null, mint = null) {
  const stakingOwners = new Set(roles.staking ?? []);
  if (tx && mint) for (const o of ownersOfTokenAccounts(tx, mint, roles.staking)) stakingOwners.add(o);
  const events = [];
  for (const { from, to, raw } of transfers) {
    const fromCex = from !== null && roles.cex.has(from);
    const toCex = to !== null && roles.cex.has(to);
    const fromDex = from !== null && roles.dex.has(from);
    const toDex = to !== null && roles.dex.has(to);
    const venueSide = fromCex || toCex || fromDex || toDex;
    if (!venueSide) continue;
    const staking = (from !== null && stakingOwners.has(from)) || (to !== null && stakingOwners.has(to));
    if (staking) events.push({ kind: "staking", venue: (fromCex ? roles.cex.get(from) : toCex ? roles.cex.get(to) : "dex"), counterparty: fromCex || fromDex ? to : from, raw });
    else if (fromCex && toCex) events.push({ kind: "internal", venue: roles.cex.get(to), counterparty: from, raw });
    else if (toCex) events.push({ kind: "cexIn", venue: roles.cex.get(to), counterparty: from, raw });
    else if (fromCex) events.push({ kind: "cexOut", venue: roles.cex.get(from), counterparty: to, raw });
    else if (toDex && !fromDex) events.push({ kind: "dexIn", venue: "dex", counterparty: from, raw });
    else if (fromDex && !toDex) events.push({ kind: "dexOut", venue: "dex", counterparty: to, raw });
  }
  return events;
}

/**
 * All non-failed signatures of one token account newer than `until` and not
 * older than `sinceSec`, newest first. Throws if the page cap is hit before the
 * start is reached (a partial list would corrupt the oldest-first resume).
 * An explicit `maxPages` replaces the default cap and throws `PAGE_CAP`.
 */
export async function listSignatures(call, account, { until = null, sinceSec = 0, pageSize = SIGNATURE_PAGE, maxPages = null } = {}) {
  const out = [];
  let before = null;
  const pageCap = maxPages ?? MAX_PAGES;
  for (let page = 0; page < pageCap; page += 1) {
    const opts = { limit: pageSize, commitment: "finalized" };
    if (before) opts.before = before;
    if (until) opts.until = until;
    const rows = (await call("getSignaturesForAddress", [account, opts])) ?? [];
    let reachedFloor = false;
    for (const r of rows) {
      if (r.blockTime != null && r.blockTime < sinceSec) {
        reachedFloor = true;
        break;
      }
      if (!r.err && r.blockTime != null) out.push({ signature: r.signature, slot: r.slot, blockTime: r.blockTime });
    }
    if (reachedFloor || rows.length < pageSize) return out;
    before = rows[rows.length - 1].signature;
  }
  if (maxPages != null) throw new Error("PAGE_CAP");
  throw new Error(`getSignaturesForAddress ${account}: more than ${MAX_PAGES} pages; refusing a partial list`);
}

/**
 * A null result is often a transient RPC miss rather than a pruned tx, so it
 * gets one fresh request before the caller treats it as unavailable.
 */
async function fetchTransactionOnce(call, signature) {
  const first = await getTransactionAnyVersion(call, signature);
  return first ?? getTransactionAnyVersion(call, signature);
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * One scan pass for one chain.
 * @param {object} p
 * @param {(method: string, params: any[]) => Promise<any>} p.call
 * @param {string} p.mint
 * @param {Array<{address: string, exchange: string}>} p.cexWallets
 * @param {string[]} p.dexOwners
 * @param {string[]} p.stakingAddresses
 * @param {{accounts?: Record<string, {owner: string, until: string|null}>}} p.state previous chain checkpoint
 * @param {number} p.sinceSec UTC seconds floor (first real snapshot day)
 * @param {number} p.maxTx transactions fetched this run
 * @param {Array<{signature: string, slot: number, blockTime: number}>} [p.state.unavailable] carried from the checkpoint
 * @returns {Promise<{ events: Array<object>, accounts: object, remaining: number, missing: number, processed: number, unavailable: Array<object>, timedOut: boolean }>}
 */
export async function scanVenueFlows({
  call, mint, cexWallets, dexOwners, stakingAddresses, state, sinceSec, maxTx, concurrency = 4,
  chunkSize = DEFAULT_CHUNK, deadlineMs = Infinity, onProgress = null, logger = console,
}) {
  const roles = {
    cex: new Map(cexWallets.map((w) => [w.address, w.exchange])),
    dex: new Set(dexOwners),
    staking: new Set(stakingAddresses),
  };
  const owners = [...roles.cex.keys(), ...roles.dex];
  const prev = state?.accounts ?? {};

  const tokenAccounts = [];
  for (const owner of owners) {
    const res = await call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
    for (const a of res?.value ?? []) tokenAccounts.push({ account: a.pubkey, owner });
  }

  const lists = new Map();
  const merged = new Map();
  for (const { account, owner } of tokenAccounts) {
    const sigs = await listSignatures(call, account, { until: prev[account]?.until ?? null, sinceSec });
    lists.set(account, sigs);
    for (const s of sigs) if (!merged.has(s.signature)) merged.set(s.signature, s);
  }

  const ordered = [...merged.values()].sort(bySlotThenSig);
  // Whole-slot cutoff: same-slot signatures are ordered differently by the RPC
  // than here, so never split a slot across two runs (or two chunks).
  const wholeSlotEnd = (end, limit) => {
    let e = Math.min(limit, end);
    while (e > 0 && e < limit && ordered[e].slot === ordered[e - 1].slot) e += 1;
    return e;
  };
  const limit = wholeSlotEnd(Math.max(0, maxTx), ordered.length);

  const done = new Set();
  const events = [];
  let missing = 0;
  let unavailable = [...(state?.unavailable ?? [])];

  // Per-account cursor = newest processed signature. Valid after any whole-slot
  // prefix, because processing is globally oldest-first.
  const cursors = () => {
    const accounts = {};
    let remaining = 0;
    for (const { account, owner } of tokenAccounts) {
      const sigs = lists.get(account);
      const newestDone = sigs.find((s) => done.has(s.signature));
      remaining += sigs.filter((s) => !done.has(s.signature)).length;
      accounts[account] = { owner, until: newestDone ? newestDone.signature : prev[account]?.until ?? null };
    }
    // Accounts seen before but no longer returned (closed): keep their cursor.
    for (const [account, v] of Object.entries(prev)) if (!accounts[account]) accounts[account] = v;
    return { accounts, remaining };
  };

  // Chunked so a crash or the wall-clock deadline keeps everything already
  // fetched: onProgress persists each chunk (new events + advanced cursors).
  let timedOut = false;
  for (let start = 0; start < limit; ) {
    if (Date.now() >= deadlineMs) {
      timedOut = true;
      break;
    }
    const end = wholeSlotEnd(start + Math.max(1, chunkSize), limit);
    const chunk = ordered.slice(start, end);
    const txs = await mapLimit(chunk, concurrency, (s) => fetchTransactionOnce(call, s.signature));
    const fresh = [];
    chunk.forEach((s, i) => {
      // The cursor advances even for an unavailable tx: it is recorded, not retried forever.
      done.add(s.signature);
      const tx = txs[i];
      if (!tx) {
        missing += 1;
        unavailable = [...unavailable, { signature: s.signature, slot: s.slot, blockTime: s.blockTime }].slice(-UNAVAILABLE_CAP);
        logger.warn?.(`  getTransaction ${s.signature.slice(0, 12)}...: no result (pruned?); recorded as unavailable`);
        return;
      }
      const transfers = pairTransfers(mintDeltasByOwner(tx, mint));
      for (const e of classifyTransfers(transfers, roles, tx, mint)) {
        fresh.push({ ...e, signature: s.signature, blockTime: s.blockTime, date: utcDay(s.blockTime), raw: e.raw.toString() });
      }
    });
    events.push(...fresh);
    start = end;
    if (onProgress) await onProgress({ newEvents: fresh, ...cursors(), missing, processed: done.size, unavailable });
  }

  const { accounts, remaining } = cursors();
  return { events, accounts, remaining, missing, processed: done.size, unavailable, timedOut };
}
