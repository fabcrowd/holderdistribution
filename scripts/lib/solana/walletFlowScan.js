/**
 * Wallet-level flow scan for Solana. Unlike flowScan.js (venue accounts), this
 * reads each registry wallet's own token account of `mint` and classifies every
 * outflow by its destination (CEX, DEX, staking, internal, unlabelled).
 *
 * Ordering and resume match flowScan.js: signatures from every account are
 * merged and processed OLDEST FIRST in whole-slot steps. Each account's cursor
 * (`until`) advances to its newest processed signature, so the cursor is only
 * correct while the processed set is a prefix of that global order. The
 * per-wallet cap therefore cuts the prefix (it never skips a signature), which
 * means a busy wallet can hold back newer signatures of other wallets until its
 * backlog drains.
 *
 * Pure with respect to disk: the caller loads and persists `state`.
 */
import { HELIUS_DEFAULT_CREDITS } from "../rpcMetrics.js";
import { bySlotThenSig, listSignatures, mapLimit, pairTransfers, SIGNATURE_PAGE } from "./flowScan.js";
import { getTransactionAnyVersion } from "./getTransaction.js";
import { detectSale } from "./saleDetect.js";
import { mintDeltasByOwner } from "./tokenFlows.js";
import { classifyWalletTransfers, pruneEvents, toWalletEvents } from "./walletFlowsSolana.js";

const DAY_SECONDS = 86400;
const LOOKBACK_SECONDS = 90 * DAY_SECONDS;

const sameSlot = (ordered, i) => ordered[i - 1].slot === ordered[i].slot;
const eventKey = (e) => `${e.sig}|${e.wallet}|${e.dest}|${e.raw}`;
const listingCost = (signatureCount) => (Math.ceil(signatureCount / SIGNATURE_PAGE) || 1) * HELIUS_DEFAULT_CREDITS;

/** One listSignatures call per account, resuming from its own checkpoint. */
async function listAccounts(call, accounts, prevAccounts, nowSec) {
  const out = [];
  for (const { wallet, tokenAccount } of accounts) {
    const until = prevAccounts[tokenAccount]?.until ?? null;
    const sigs = await listSignatures(call, tokenAccount, { until, sinceSec: nowSec - LOOKBACK_SECONDS });
    out.push({ wallet, tokenAccount, sigs });
  }
  return out;
}

/** Unique signatures across accounts, oldest first, each with the set of wallets it touches. */
function mergeListings(listed) {
  const bySig = new Map();
  for (const { wallet, sigs } of listed) {
    for (const s of sigs) {
      const entry = bySig.get(s.signature) ?? { signature: s.signature, slot: s.slot, blockTime: s.blockTime, wallets: new Set() };
      entry.wallets.add(wallet);
      bySig.set(s.signature, entry);
    }
  }
  return [...bySig.values()].sort(bySlotThenSig);
}

function countPerWallet(ordered) {
  const counts = {};
  for (const { wallets } of ordered) for (const w of wallets) counts[w] = (counts[w] ?? 0) + 1;
  return counts;
}

/** Index of the first signature that would push some wallet past perWalletMax (or the end). */
function perWalletCapEnd(ordered, perWalletMax) {
  const used = new Map();
  for (let i = 0; i < ordered.length; i += 1) {
    const { wallets } = ordered[i];
    if ([...wallets].some((w) => (used.get(w) ?? 0) >= perWalletMax)) return i;
    for (const w of wallets) used.set(w, (used.get(w) ?? 0) + 1);
  }
  return ordered.length;
}

/** Extends `end` forward to the end of its slot (flowScan.wholeSlotEnd). */
function forwardSlotEnd(ordered, end) {
  let e = Math.min(end, ordered.length);
  while (e > 0 && e < ordered.length && sameSlot(ordered, e)) e += 1;
  return e;
}

/**
 * Moves a cut back to the start of the slot it splits. If that slot starts at
 * index 0 there is nothing earlier to keep, so the whole slot is taken instead.
 */
function alignCapToSlot(ordered, end) {
  if (end <= 0 || end >= ordered.length || !sameSlot(ordered, end)) return end;
  let e = end;
  while (e > 0 && sameSlot(ordered, e)) e -= 1;
  return e > 0 ? e : forwardSlotEnd(ordered, end);
}

/** Number of leading signatures to process this run: maxTx (whole slot) and the per-wallet cap. */
function runLimit(ordered, maxTx, perWalletMax) {
  const maxTxEnd = forwardSlotEnd(ordered, Math.max(0, maxTx));
  const capEnd = perWalletCapEnd(ordered, perWalletMax);
  return capEnd >= maxTxEnd ? maxTxEnd : alignCapToSlot(ordered, capEnd);
}

function chunkEnd(ordered, start, limit, chunkSize) {
  let e = Math.min(start + Math.max(1, chunkSize), limit);
  while (e < limit && sameSlot(ordered, e)) e += 1;
  return e;
}

/**
 * Sales in one tx: for each wallet with DEX outflows in it, the summed raw sent
 * to DEX owners is the sold amount. Wallets with no detectable sale yield nothing.
 */
function saleRecordsForTx({ tx, signature, blockTime, walletEvents, mint, dexOwners }) {
  const soldByWallet = new Map();
  for (const e of walletEvents) {
    if (e.kind !== "DEX") continue;
    soldByWallet.set(e.wallet, (soldByWallet.get(e.wallet) ?? 0n) + BigInt(e.raw));
  }
  const sales = [];
  for (const [wallet, soldRaw] of soldByWallet) {
    const sale = detectSale({ tx, signature, blockTime, wallet, zbcnMint: mint, soldRaw, dexOwners });
    if (sale) sales.push(sale);
  }
  return sales;
}

/**
 * Fetches and classifies the first `limit` signatures in chunks. Stops before a
 * chunk once the deadline has passed. A null transaction counts as missing.
 * When `dexOwners` is set, also returns the sales detected in those transactions.
 */
async function processPrefix({ call, ordered, limit, mint, roles, concurrency, chunkSize, deadlineMs, logger, dexOwners = null }) {
  const events = [];
  const sales = [];
  let missing = 0;
  let done = 0;
  while (done < limit && Date.now() < deadlineMs) {
    const end = chunkEnd(ordered, done, limit, chunkSize);
    const chunk = ordered.slice(done, end);
    const txs = await mapLimit(chunk, concurrency, (s) => getTransactionAnyVersion(call, s.signature));
    chunk.forEach((s, i) => {
      const tx = txs[i];
      if (!tx) {
        missing += 1;
        logger.warn?.(`  getTransaction ${s.signature.slice(0, 12)}...: no result; skipped`);
        return;
      }
      const classified = classifyWalletTransfers(pairTransfers(mintDeltasByOwner(tx, mint)), roles);
      const walletEvents = toWalletEvents(classified, { signature: s.signature, blockTime: s.blockTime });
      events.push(...walletEvents);
      if (dexOwners) {
        sales.push(...saleRecordsForTx({ tx, signature: s.signature, blockTime: s.blockTime, walletEvents, mint, dexOwners }));
      }
    });
    done = end;
  }
  return { done, missing, events, sales };
}

/** Cursor per account = newest processed signature of that account; kept if none processed. Closed accounts keep theirs. */
function nextAccounts(prevAccounts, listed, processed) {
  const accounts = { ...prevAccounts };
  for (const { wallet, tokenAccount, sigs } of listed) {
    const newest = sigs.find((s) => processed.has(s.signature));
    accounts[tokenAccount] = { wallet, until: newest ? newest.signature : (prevAccounts[tokenAccount]?.until ?? null) };
  }
  return accounts;
}

/** Appends new events, skipping any already in state, then drops events outside the 90-day window. */
function mergeEvents(prevEvents, fresh, nowSec) {
  const seen = new Set(prevEvents.map(eventKey));
  const added = [];
  for (const e of fresh) {
    const key = eventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(e);
  }
  return pruneEvents([...prevEvents, ...added], nowSec);
}

/** Merges sales keyed by sig+wallet (a fresh record replaces a previous one), then drops sales outside the 90-day window. */
function mergeSales(prevSales, fresh, nowSec) {
  const bySaleKey = new Map();
  for (const sale of [...prevSales, ...fresh]) bySaleKey.set(`${sale.sig}|${sale.wallet}`, sale);
  const floor = nowSec - LOOKBACK_SECONDS;
  return [...bySaleKey.values()].filter((sale) => sale.t >= floor);
}

/**
 * One wallet-flow scan pass.
 * @param {object} p
 * @param {(method: string, params: unknown[]) => Promise<unknown>} p.call
 * @param {Array<{wallet: string, tokenAccount: string}>} p.accounts token accounts of `mint` owned by registry wallets
 * @param {string} p.mint
 * @param {{wallets: Set<string>, cex: Map<string, string>, dex: Set<string>, staking: Set<string>}} p.roles
 * @param {{accounts?: Record<string, {wallet: string, until: string|null}>, events?: Array<object>}|null} [p.state]
 * @param {number} p.nowSec
 * @param {{maxTx?: number, perWalletMax?: number, deadlineMs?: number, concurrency?: number, chunkSize?: number}} [p.caps]
 * @param {boolean} [p.dryRun] count signatures and estimate credits; no getTransaction calls
 * @param {{warn?: Function}} [p.logger]
 * @param {{dexOwners: Set<string>}|null} [p.journal] when set, also records sales into `state.sales`
 */
export async function scanWalletFlows({ call, accounts, mint, roles, state, nowSec, caps = {}, dryRun = false, logger = console, journal = null }) {
  const { maxTx = 2500, perWalletMax = 400, deadlineMs = Infinity, concurrency = 4, chunkSize = 60 } = caps;
  const prevAccounts = state?.accounts ?? {};
  const prevEvents = state?.events ?? [];
  const prevSales = state?.sales ?? [];

  const listed = await listAccounts(call, accounts, prevAccounts, nowSec);
  const ordered = mergeListings(listed);
  const listingCredits = listed.reduce((sum, { sigs }) => sum + listingCost(sigs.length), 0);

  if (dryRun) {
    return {
      state: {
        ...state,
        accounts: { ...prevAccounts },
        events: [...prevEvents],
        ...(state?.sales ? { sales: [...state.sales] } : {}),
      },
      counts: { signatures: ordered.length, perWallet: countPerWallet(ordered), transactions: 0 },
      estimatedCredits: listingCredits + ordered.length * HELIUS_DEFAULT_CREDITS,
      truncated: false,
    };
  }

  const limit = runLimit(ordered, maxTx, perWalletMax);
  const { done, missing, events, sales } = await processPrefix({
    call,
    ordered,
    limit,
    mint,
    roles,
    concurrency,
    chunkSize,
    deadlineMs,
    logger,
    dexOwners: journal?.dexOwners ?? null,
  });
  const processed = new Set(ordered.slice(0, done).map((s) => s.signature));
  const nextState = {
    ...state,
    accounts: nextAccounts(prevAccounts, listed, processed),
    events: mergeEvents(prevEvents, events, nowSec),
  };
  if (journal) nextState.sales = mergeSales(prevSales, sales, nowSec);
  return {
    state: nextState,
    counts: { signatures: ordered.length, processed: done, missing, transactions: done - missing },
    estimatedCredits: listingCredits + done * HELIUS_DEFAULT_CREDITS,
    truncated: done < ordered.length,
  };
}
