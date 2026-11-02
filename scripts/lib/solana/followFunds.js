/**
 * Follows the outflow of one traced or sale-side token account, one hop at a
 * time. A task carries a budget (`remaining`, raw units) of tokens to trace.
 * Each pass reads the signatures of its account newer than `until`, oldest
 * first, and emits a hop for every transfer out of the owner until the budget
 * is spent. Recipients that are not labelled become next tasks, one level deeper.
 *
 * Progress is committed only when a pass finishes. A budget error or any other
 * failure returns the task unchanged apart from its status, so a rerun repeats
 * the whole pass.
 *
 * Owners are base58 and compared exactly as given (never case-folded).
 */
import { CallBudgetError } from "./callBudget.js";
import { bySlotThenSig, listSignatures, mapLimit, pairTransfers } from "./flowScan.js";
import { getTransactionAnyVersion } from "./getTransaction.js";
import { allMintDeltasByOwner } from "./tokenFlows.js";
import { classifyFrom } from "./walletFlowsSolana.js";

const SECONDS_PER_DAY = 86400;
const FOLLOW_WINDOW_SEC = 90 * SECONDS_PER_DAY;
const SIGNATURE_PAGE = 100;
const TX_CONCURRENCY = 4;
const PAGE_CAP = "PAGE_CAP";
const UNLABELLED = "unlabelled";
const TERMINAL_STATUSES = new Set(["done", "untracked"]);
const TOKEN_ACCOUNT_OPTS = { encoding: "jsonParsed", commitment: "finalized" };

const withStatus = (task, status) => ({ task: { ...task, status }, hops: [], nextTasks: [] });

/**
 * One pass of a task. Returns `{ task, hops, nextTasks }`; the input task is
 * never mutated.
 * @param {object} p
 * @param {(method: string, params: any[]) => Promise<any>} p.call
 * @param {object} p.task
 * @param {{cex: Map<string, string>, dex: Set<string>, staking: Set<string>, wallets: Set<string>}} p.roles
 * @param {number} p.nowSec
 * @param {number} [p.maxTx] transactions read per pass
 * @param {number} [p.maxDepth] hops deeper than this are not followed
 * @returns {Promise<{task: object, hops: object[], nextTasks: object[]}>}
 */
export async function followTask({ call, task, roles, nowSec, maxTx = 30, maxDepth = 1 }) {
  if (TERMINAL_STATUSES.has(task.status)) return { task, hops: [], nextTasks: [] };
  try {
    return await followOpenTask({ call, task, roles, nowSec, maxTx, maxDepth });
  } catch (err) {
    if (err instanceof CallBudgetError) return withStatus(task, "budget");
    return withStatus(task, "error");
  }
}

async function followOpenTask({ call, task, roles, nowSec, maxTx, maxDepth }) {
  const working = task.account === null ? await withResolvedAccount(call, task) : task;
  if (working === null) return withStatus(task, "done");

  let sigs;
  try {
    sigs = await listSignatures(call, working.account, {
      until: working.until,
      sinceSec: working.sinceSec,
      pageSize: SIGNATURE_PAGE,
      maxPages: 1,
    });
  } catch (err) {
    if (err?.message === PAGE_CAP) return withStatus(working, "busy");
    throw err;
  }

  const ordered = [...sigs].sort(bySlotThenSig);
  const slice = ordered.slice(0, maxTx);
  const txs = await mapLimit(slice, TX_CONCURRENCY, (s) => getTransactionAnyVersion(call, s.signature));
  const { hops, nextTasks, remaining } = emitHops({ task: working, slice, txs, roles, maxDepth });

  const fullyProcessed = slice.length === ordered.length;
  const aged = nowSec - working.sinceSec > FOLLOW_WINDOW_SEC;
  const finished = remaining === 0n || (fullyProcessed && aged);
  const until = slice.length > 0 ? slice[slice.length - 1].signature : working.until;
  return {
    task: { ...working, until, remaining: remaining.toString(), status: finished ? "done" : "open" },
    hops,
    nextTasks,
  };
}

/** Resolves the first token account of `task.owner` for `task.mint`, or null when there is none. */
async function withResolvedAccount(call, task) {
  const res = await call("getTokenAccountsByOwner", [task.owner, { mint: task.mint }, TOKEN_ACCOUNT_OPTS]);
  const account = res?.value?.[0]?.pubkey;
  return account ? { ...task, account } : null;
}

/**
 * Walks the processed transactions oldest first and emits hops until the
 * budget is spent. Null transactions (pruned) are skipped.
 */
function emitHops({ task, slice, txs, roles, maxDepth }) {
  let remaining = BigInt(task.remaining);
  const hops = [];
  const nextTasks = [];
  const createdIds = new Set();
  for (let i = 0; i < slice.length && remaining > 0n; i += 1) {
    const tx = txs[i];
    if (!tx) continue;
    for (const c of classifyTxOut(tx, task, roles)) {
      if (remaining === 0n) break;
      const raw = c.raw < remaining ? c.raw : remaining;
      remaining -= raw;
      const hop = toHop(task, c, raw, slice[i]);
      hops.push(hop);
      if (c.kind !== UNLABELLED || task.depth >= maxDepth) continue;
      const next = nextTaskFor(task, hop, c.account);
      if (createdIds.has(next.id)) continue;
      createdIds.add(next.id);
      nextTasks.push(next);
    }
  }
  return { hops, nextTasks, remaining };
}

/**
 * Transfers out of `task.owner` in one transaction for `task.mint`, each with
 * the recipient's token account for that mint (null when not in the tx).
 */
function classifyTxOut(tx, task, roles) {
  const byOwner = allMintDeltasByOwner(tx);
  const deltas = new Map();
  for (const [owner, byMint] of byOwner) {
    const entry = byMint.get(task.mint);
    if (entry) deltas.set(owner, entry.raw);
  }
  return classifyFrom(pairTransfers(deltas), task.owner, roles).map((c) => ({
    ...c,
    account: byOwner.get(c.dest)?.get(task.mint)?.account ?? null,
  }));
}

function toHop(task, c, raw, signature) {
  return {
    taskId: task.id,
    depth: task.depth,
    from: c.wallet,
    to: c.dest,
    kind: c.kind,
    venue: c.venue,
    mint: task.mint,
    raw: raw.toString(),
    t: signature.blockTime,
    sig: signature.signature,
  };
}

export function nextTaskFor(task, hop, account) {
  return {
    id: `${task.kind}|${task.ref}|${hop.to}|${task.mint}`,
    kind: task.kind,
    ref: task.ref,
    rootWallet: task.rootWallet,
    owner: hop.to,
    account,
    mint: task.mint,
    decimals: task.decimals,
    sinceSec: hop.t,
    remaining: hop.raw,
    depth: task.depth + 1,
    until: null,
    status: "open",
  };
}
