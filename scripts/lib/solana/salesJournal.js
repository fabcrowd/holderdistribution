/**
 * Pure 90-day journal of wallet token sales: what each sale brought in, its USD
 * value and where the proceeds went next. No I/O.
 *
 * Addresses are base58 and case-sensitive: compared and shown exactly as given.
 */
import { WINDOW_SECONDS } from "../walletFlows.js";
import { WSOL_MINT, knownDecimalsOf, symbolOf } from "./knownMints.js";

const WINDOW = "90d";
const SALE_TASK = "sale";
const TASK_DONE = "done";
const TASK_OPEN = "open";
const UNFINISHED_STATUSES = new Set(["open", "busy", "budget"]);
const SOL_SYMBOL = "SOL";
const STABLE_SYMBOLS = new Set(["USDC", "USDT"]);

export const toIso = (sec) => new Date(sec * 1000).toISOString();
export const shortAddress = (address) => `${address.slice(0, 4)}...${address.slice(-4)}`;
/** Converts a raw integer amount (string or bigint) to UI units at the last step. */
export const toUiAmount = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;
export const labelsByAddress = (registry) =>
  new Map((registry?.knownWallets ?? []).map((w) => [w.address, w.label]));

/** True when taskRef is ref itself or a ref extended by a further `|` segment. */
export function isSameOrChildRef(taskRef, ref) {
  return taskRef === ref || taskRef.startsWith(`${ref}|`);
}

/** Orders hops by depth, then by time. */
export function compareHops(a, b) {
  return a.depth - b.depth || a.t - b.t;
}

const saleRef = (sale) => `${sale.sig}|${sale.wallet}`;

/**
 * Only wallet-held legs are proceeds. A sale with none of those falls back to
 * the legs held by other accounts.
 */
function proceedLegs(sale) {
  const walletLegs = sale.legs.filter((leg) => leg.holder === "wallet");
  return walletLegs.length > 0 ? walletLegs : sale.legs.filter((leg) => leg.holder === "other");
}

/** USD value of one leg's UI amount, or null when the mint has no price here. */
function valueLeg(mint, amount, solUsd) {
  const symbol = symbolOf(mint);
  if (symbol === SOL_SYMBOL) return solUsd > 0 ? amount * solUsd : null;
  if (STABLE_SYMBOLS.has(symbol)) return amount;
  return null;
}

function toProceed(leg, solUsd) {
  const amount = toUiAmount(leg.raw, leg.decimals);
  return {
    mint: leg.mint,
    symbol: symbolOf(leg.mint),
    raw: leg.raw,
    decimals: leg.decimals,
    amount,
    usd: valueLeg(leg.mint, amount, solUsd),
    source: leg.source,
  };
}

/** Null when any leg is unvalued, so a partial total never looks complete. */
function sumUsd(proceeds) {
  if (proceeds.some((p) => p.usd === null)) return null;
  return proceeds.reduce((sum, p) => sum + p.usd, 0);
}

function effectivePrice(proceedsUsd, zbcnSold) {
  if (proceedsUsd === null || zbcnSold === 0) return null;
  return proceedsUsd / zbcnSold;
}

function relatedTasks(sale, tasks) {
  const ref = saleRef(sale);
  return tasks.filter(
    (t) =>
      (t.kind === SALE_TASK && t.ref === ref) ||
      (t.rootWallet === sale.wallet && isSameOrChildRef(t.ref, ref)),
  );
}

/**
 * Precedence: no task at all is untracked; a native leg with no hops is
 * untracked (SOL moved outside the token trace); no hops with every sale task
 * finished is none-seen; every task done is complete; anything else is partial.
 */
function onwardStatusOf(proceeds, related, onward) {
  if (related.length === 0) return "untracked";
  const hasHops = onward.length > 0;
  if (!hasHops && proceeds.some((p) => p.source === "native")) return "untracked";
  const saleTasks = related.filter((t) => t.kind === SALE_TASK);
  const noneSeen =
    !hasHops &&
    saleTasks.length > 0 &&
    saleTasks.every((t) => t.status === TASK_DONE || t.status === TASK_OPEN);
  if (noneSeen) return "none-seen";
  if (related.every((t) => t.status === TASK_DONE)) return "complete";
  return "partial";
}

function decimalsIndex(tasks, sales) {
  const index = new Map();
  for (const task of tasks) {
    if (task.mint) index.set(task.mint, task.decimals);
  }
  for (const sale of sales) {
    for (const leg of sale.legs) index.set(leg.mint, leg.decimals);
  }
  return index;
}

function onwardHops(related, hops, decimals, explorerTx) {
  const taskIds = new Set(related.map((t) => t.id));
  return hops
    .filter((hop) => taskIds.has(hop.taskId))
    .sort(compareHops)
    .map((hop) => {
      const mintDecimals = decimals.get(hop.mint) ?? knownDecimalsOf(hop.mint);
      return {
        hop: hop.depth,
        from: hop.from,
        to: hop.to,
        kind: hop.kind,
        venue: hop.venue,
        mint: hop.mint,
        symbol: symbolOf(hop.mint),
        amount: mintDecimals == null ? null : toUiAmount(hop.raw, mintDecimals),
        sig: hop.sig,
        url: explorerTx(hop.sig),
        t: toIso(hop.t),
      };
    });
}

function journalRow(sale, ctx) {
  const zbcnSold = toUiAmount(sale.soldRaw, ctx.zbcnDecimals);
  const proceeds = proceedLegs(sale).map((leg) => toProceed(leg, ctx.solUsd));
  const proceedsUsd = sumUsd(proceeds);
  const related = relatedTasks(sale, ctx.tasks);
  const onward = onwardHops(related, ctx.hops, ctx.decimals, ctx.explorerTx);
  return {
    wallet: sale.wallet,
    label: ctx.labels.get(sale.wallet) ?? shortAddress(sale.wallet),
    sig: sale.sig,
    url: ctx.explorerTx(sale.sig),
    t: toIso(sale.t),
    zbcnSold,
    proceeds,
    proceedsUsd,
    effectivePriceUsd: effectivePrice(proceedsUsd, zbcnSold),
    onwardStatus: onwardStatusOf(proceeds, related, onward),
    onward,
  };
}

function totalsOf(sales, rows, zbcnDecimals) {
  const soldRaw = sales.reduce((sum, sale) => sum + BigInt(sale.soldRaw), 0n);
  return {
    count: rows.length,
    zbcnSold: toUiAmount(soldRaw, zbcnDecimals),
    proceedsUsd: rows.some((r) => r.proceedsUsd === null)
      ? null
      : rows.reduce((sum, r) => sum + r.proceedsUsd, 0),
  };
}

const newestFirst = (a, b) => b.t - a.t || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0);

/**
 * Sales inside the 90-day window, newest first. Totals cover every in-window
 * sale; `sales` is capped at `limit`.
 * @returns {object | null} null when no sale falls in the window
 */
export function buildSalesJournal({
  sales,
  follow,
  registry,
  nowSec,
  zbcnDecimals,
  solUsd = 0,
  limit = 50,
  explorerTx = (sig) => "https://solscan.io/tx/" + sig,
}) {
  const floor = nowSec - WINDOW_SECONDS[WINDOW];
  const inWindow = sales.filter((s) => s.t >= floor).sort(newestFirst);
  if (inWindow.length === 0) return null;
  const tasks = Object.values(follow?.tasks ?? {});
  const ctx = {
    labels: labelsByAddress(registry),
    tasks,
    hops: follow?.hops ?? [],
    decimals: decimalsIndex(tasks, sales),
    zbcnDecimals,
    solUsd,
    explorerTx,
  };
  const rows = inWindow.map((sale) => journalRow(sale, ctx));
  return {
    window: WINDOW,
    valuedAtReportTime: rows.some((r) => r.proceeds.some((p) => p.symbol === SOL_SYMBOL && p.usd !== null)),
    totals: totalsOf(inWindow, rows, zbcnDecimals),
    sales: rows.slice(0, limit),
  };
}
