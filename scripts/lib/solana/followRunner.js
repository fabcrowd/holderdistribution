/**
 * Seeds follow tasks from unlabelled transfers (`state.events`) and sale legs
 * (`state.sales`), then runs them through `followTask` under a call budget.
 * Sale-side tasks run before trace tasks; within each group the largest
 * remaining balance goes first. The input state is never mutated.
 *
 * Keys are base58 and kept exactly as given (never case-folded).
 */
import { CallBudgetError, createCallBudget } from "./callBudget.js";
import { followTask, nextTaskFor } from "./followFunds.js";

const SECONDS_PER_DAY = 86400;
const FOLLOW_WINDOW_SEC = 90 * SECONDS_PER_DAY;
const MAX_DEPTH = 2;
const ELIGIBLE_STATUSES = new Set(["open", "budget"]);
// Transient "error" tasks get another chance on later runs, up to this many attempts in total.
// "busy" stays permanent: the account is too heavy to trace, which a retry would not change.
const MAX_ERROR_ATTEMPTS = 3;
const ERROR_STATUS = "error";
const SALE_KIND = "sale";
const UNLABELLED = "unlabelled";
const HOLDER_WALLET = "wallet";

const emptyFollow = () => ({ tasks: {}, hops: [] });
const cutoffSec = (nowSec) => nowSec - FOLLOW_WINDOW_SEC;
const clampDepth = (depth) => Math.min(MAX_DEPTH, Math.max(0, depth));

/**
 * Adds one task per unseeded item. Existing ids are kept untouched, so seeding
 * the same state twice yields the same tasks.
 * @param {object} state
 * @param {{nowSec: number, minRaw?: bigint, mint: string, decimals: number, maxTraceDepth?: number}} opts
 * @returns {{tasks: Record<string, object>, hops: object[]}} a new follow object
 */
export function seedTasks(state, { nowSec, minRaw = 0n, mint, decimals, maxTraceDepth = 1 }) {
  const base = state?.follow ?? emptyFollow();
  const tasks = { ...base.tasks };
  const add = (task) => {
    if (!Object.hasOwn(tasks, task.id)) tasks[task.id] = task;
  };

  if (maxTraceDepth >= 1) {
    for (const ev of state?.events ?? []) {
      if (!isSeedableTransfer(ev, { nowSec, minRaw })) continue;
      add(traceTaskFor(ev, mint, decimals));
    }
  }

  for (const sale of state?.sales ?? []) {
    if (sale.t < cutoffSec(nowSec)) continue;
    for (const leg of sale.legs ?? []) {
      if (leg.holder !== HOLDER_WALLET) continue;
      if (leg.source === "token" && leg.account != null) add(saleTaskFor(sale, leg, leg.account, "open"));
      else if (leg.source === "native") add(saleTaskFor(sale, leg, null, "untracked"));
    }
  }

  return { tasks, hops: [...base.hops] };
}

/**
 * Adds the next-depth task for each stored unlabelled hop whose parent task
 * may still go deeper. Hops record earlier passes, so this recovers tasks a
 * shallower run never created. Existing ids are kept, so the call is idempotent.
 * @param {{tasks: Record<string, object>, hops: object[]}} follow
 * @param {{nowSec: number, maxTraceDepth: number, maxSaleDepth: number}} opts
 * @returns {{tasks: Record<string, object>, hops: object[]}} a new follow object
 */
export function seedDeeperTasks(follow, { nowSec, maxTraceDepth, maxSaleDepth }) {
  const tasks = { ...follow.tasks };
  const cutoff = cutoffSec(nowSec);
  for (const hop of follow.hops) {
    if (hop.kind !== UNLABELLED || typeof hop.t !== "number" || hop.t < cutoff) continue;
    const parent = follow.tasks[hop.taskId];
    if (!parent) continue;
    const allowedDepth = clampDepth(parent.kind === SALE_KIND ? maxSaleDepth : maxTraceDepth);
    if (parent.depth >= allowedDepth) continue;
    const next = nextTaskFor(parent, hop, null);
    if (!Object.hasOwn(tasks, next.id)) tasks[next.id] = next;
  }
  return { tasks, hops: [...follow.hops] };
}

function isSeedableTransfer(ev, { nowSec, minRaw }) {
  return ev.kind === UNLABELLED && BigInt(ev.raw) >= minRaw && ev.t >= cutoffSec(nowSec);
}

function traceTaskFor(ev, mint, decimals) {
  return {
    id: `trace|${ev.sig}|${ev.wallet}|${ev.dest}|${mint}`,
    kind: "trace",
    ref: `${ev.sig}|${ev.wallet}|${ev.dest}`,
    rootWallet: ev.wallet,
    owner: ev.dest,
    account: null,
    mint,
    decimals,
    sinceSec: ev.t,
    remaining: ev.raw,
    depth: 1,
    until: null,
    status: "open",
  };
}

function saleTaskFor(sale, leg, account, status) {
  return {
    id: `${SALE_KIND}|${sale.sig}|${sale.wallet}|${leg.mint}`,
    kind: SALE_KIND,
    ref: `${sale.sig}|${sale.wallet}`,
    rootWallet: sale.wallet,
    owner: leg.owner,
    account,
    mint: leg.mint,
    decimals: leg.decimals,
    sinceSec: sale.t,
    remaining: leg.raw,
    depth: 1,
    until: null,
    status,
  };
}

/**
 * Runs eligible tasks (status "open", "budget", or "error" with fewer than
 * MAX_ERROR_ATTEMPTS attempts) until a limit is hit. The queue is built once, so a
 * task that ends "busy" or "error" is not retried in this run.
 * @param {object} p
 * @param {(method: string, params: any[]) => Promise<any>} p.call
 * @param {object} p.state
 * @param {object} p.roles
 * @param {number} p.nowSec
 * @param {{maxCalls?: number, maxTasks?: number, maxTx?: number, traceDepth?: number, saleDepth?: number}} [p.limits]
 * @param {number} [p.deadlineMs] epoch milliseconds after which no new task starts
 * @param {Function} [p.follower] task runner, defaults to followTask
 * @returns {Promise<{follow: {tasks: Record<string, object>, hops: object[]}, usedCalls: number}>}
 */
export async function runFollow({
  call,
  state,
  roles,
  nowSec,
  limits = {},
  deadlineMs = Infinity,
  follower = followTask,
}) {
  const { maxCalls = 300, maxTasks = 40, maxTx = 30, traceDepth = 1, saleDepth = 2 } = limits;
  const budget = createCallBudget(call, maxCalls);
  const seeded = seedDeeperTasks(state?.follow ?? emptyFollow(), {
    nowSec,
    maxTraceDepth: traceDepth,
    maxSaleDepth: saleDepth,
  });
  const tasks = { ...seeded.tasks };
  const hops = [...seeded.hops];
  const hopKeys = new Set(hops.map(hopKey));
  const queue = eligibleQueue(tasks);

  let ran = 0;
  for (let i = 0; i < queue.length; i += 1) {
    if (ran >= maxTasks || budget.exhausted() || !(Date.now() < deadlineMs)) break;
    const task = queue[i];
    ran += 1;
    const depth = clampDepth(task.kind === SALE_KIND ? saleDepth : traceDepth);
    const result = await runOne({ follower, budget, task, roles, nowSec, maxTx, maxDepth: depth });

    tasks[task.id] = countErrorAttempt(task, result.task);
    for (const hop of result.hops) {
      const key = hopKey(hop);
      if (hopKeys.has(key)) continue;
      hopKeys.add(key);
      hops.push(hop);
    }
    for (const next of result.nextTasks) {
      if (Object.hasOwn(tasks, next.id)) continue;
      tasks[next.id] = next;
      queue.push(next);
    }
  }

  return { follow: prune({ tasks, hops }, nowSec), usedCalls: budget.used() };
}

async function runOne({ follower, budget, task, roles, nowSec, maxTx, maxDepth }) {
  try {
    return await follower({ call: budget.call, task, roles, nowSec, maxTx, maxDepth });
  } catch (err) {
    const status = err instanceof CallBudgetError ? "budget" : "error";
    return { task: { ...task, status }, hops: [], nextTasks: [] };
  }
}

/** Records one more failed attempt when a task ends in "error". State from before `attempts` existed counts as 0. */
function countErrorAttempt(queued, finished) {
  if (finished.status !== ERROR_STATUS) return finished;
  return { ...finished, attempts: (queued.attempts ?? 0) + 1 };
}

const isRetryableError = (task) => task.status === ERROR_STATUS && (task.attempts ?? 0) < MAX_ERROR_ATTEMPTS;

function eligibleQueue(tasks) {
  return Object.values(tasks)
    .filter((task) => ELIGIBLE_STATUSES.has(task.status) || isRetryableError(task))
    .sort((a, b) => groupRank(a) - groupRank(b) || compareRemainingDesc(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const groupRank = (task) => (task.kind === SALE_KIND ? 0 : 1);

function compareRemainingDesc(a, b) {
  const ra = BigInt(a.remaining);
  const rb = BigInt(b.remaining);
  if (ra === rb) return 0;
  return ra > rb ? -1 : 1;
}

const hopKey = (hop) => `${hop.taskId}|${hop.sig}|${hop.to}|${hop.raw}`;

/** Drops hops and finished tasks older than the follow window. Hops without a blockTime are kept. */
function prune({ tasks, hops }, nowSec) {
  const cutoff = cutoffSec(nowSec);
  const keptTasks = Object.fromEntries(
    Object.entries(tasks).filter(([, task]) => !(task.status === "done" && task.sinceSec < cutoff)),
  );
  const keptHops = hops.filter((hop) => !(typeof hop.t === "number" && hop.t < cutoff));
  return { tasks: keptTasks, hops: keptHops };
}
