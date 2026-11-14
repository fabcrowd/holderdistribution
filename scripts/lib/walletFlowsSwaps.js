/**
 * DEX-swap receipt marking for wallet-flows transfers (RPC injected, so testable).
 *
 * `swapped` is tri-state: true = the tx emitted a swap event, false = receipt read
 * and no swap event (or gave up, see `swapCheck`), null = unknown (receipt error or
 * budget exhausted; retried on the next run). Absent (state written before this
 * field) is treated as null.
 *
 * - A null receipt is treated like an error (flaky node: the confirmation-depth overlap
 *   already handles reorgs, so events are never dropped here).
 * - Errors and null receipts count in `swapAttempts`; after MAX_SWAP_ATTEMPTS the event is
 *   settled as swapped:false with swapCheck:"gave-up" so it stays visible.
 * - Pending txs are checked newest-first so a backlog of old nulls cannot starve new candidates.
 * - A "gave-up" event is retried on later runs, but only with the receipt budget left after every pending
 *   (null/absent) tx was served, so retries can never starve new work. A retry that fails again leaves it
 *   "gave-up" (no new attempt count); one that resolves replaces the verdict and drops `swapCheck`.
 */
import { SWAP_TOPICS, classifyOutflow, norm } from "./walletFlows.js";

/**
 * Stored events that need a receipt check under the CURRENT labels: big enough, not sent by a bot
 * and still unlabelled. Chosen on every run, so a label change never needs a rescan (see
 * walletFlowsHash.js); markSwaps skips events that already carry a settled verdict.
 */
export const swapCandidates = (events, index, minCandidateTokens) =>
  events.filter((t) => t.tel >= minCandidateTokens && !index.bots.has(t.from) && classifyOutflow(t.from, t.to, index) === "unlabelled");

/**
 * TEL's value of the per-project threshold (projectSizing().minSwapCandidateTokens, which generate-wallet-flows
 * uses): unlabelled outflows at or above this many tokens get a receipt check. Part of the state hash.
 */
export const MIN_SWAP_CANDIDATE_TEL = 1e6;
export const MAX_SWAP_ATTEMPTS = 3;

const known = (v) => v === true || v === false;
const gaveUp = (t) => t.swapCheck === "gave-up";

/**
 * @param {{ fetchReceipt: (tx: string) => Promise<{logs?: {topics?: string[]}[]}|null>,
 *           transfers: {tx: string, block?: number, swapped?: boolean|null, swapAttempts?: number, swapCheck?: string}[],
 *           budget: {left: number, exhausted?: boolean},
 *           concurrency?: number }} input
 */
export async function markSwaps({ fetchReceipt, transfers, budget, concurrency = 4 }) {
  const verdicts = new Map();
  for (const t of transfers) if (known(t.swapped) && !gaveUp(t)) verdicts.set(t.tx, t.swapped);
  const newest = new Map();
  const retry = new Map();
  for (const t of transfers) {
    if (verdicts.has(t.tx)) continue;
    const bucket = gaveUp(t) ? retry : newest;
    bucket.set(t.tx, Math.max(bucket.get(t.tx) ?? -1, t.block ?? 0));
  }
  const newestFirst = (m) => [...m.keys()].sort((a, b) => m.get(b) - m.get(a));
  const pending = newestFirst(newest);
  const fresh = pending.slice(0, Math.max(0, budget.left));
  if (fresh.length < pending.length) budget.exhausted = true;
  budget.left -= fresh.length;
  // Gave-up events get a later retry only from the budget left after every never-settled candidate was served.
  const retried = newestFirst(retry)
    .filter((tx) => !newest.has(tx))
    .slice(0, Math.max(0, budget.left));
  budget.left -= retried.length;
  const checked = [...fresh, ...retried];

  const failed = new Set();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, checked.length) }, async () => {
      while (next < checked.length) {
        const tx = checked[next++];
        try {
          const r = await fetchReceipt(tx);
          if (!r) failed.add(tx);
          else verdicts.set(tx, (r.logs ?? []).some((l) => SWAP_TOPICS.has(norm(l.topics?.[0]))));
        } catch {
          failed.add(tx);
        }
      }
    }),
  );
  for (const t of transfers) {
    if (verdicts.has(t.tx)) {
      t.swapped = verdicts.get(t.tx);
      delete t.swapAttempts;
      delete t.swapCheck;
    } else if (gaveUp(t)) {
      continue; // a failed or skipped retry leaves the settled "gave-up" verdict as it was
    } else if (failed.has(t.tx)) {
      t.swapAttempts = (t.swapAttempts ?? 0) + 1;
      if (t.swapAttempts >= MAX_SWAP_ATTEMPTS) {
        t.swapped = false;
        t.swapCheck = "gave-up";
        delete t.swapAttempts;
      } else {
        t.swapped = null;
      }
    } else {
      t.swapped = null;
    }
  }
}
