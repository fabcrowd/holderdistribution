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
 */
import { SWAP_TOPICS, norm } from "./walletFlows.js";

/** Unlabelled outflows at or above this many tokens get a receipt check. Part of the state hash. */
export const MIN_SWAP_CANDIDATE_TEL = 1e6;
export const MAX_SWAP_ATTEMPTS = 3;

const known = (v) => v === true || v === false;

/**
 * @param {{ fetchReceipt: (tx: string) => Promise<{logs?: {topics?: string[]}[]}|null>,
 *           transfers: {tx: string, block?: number, swapped?: boolean|null, swapAttempts?: number, swapCheck?: string}[],
 *           budget: {left: number, exhausted?: boolean},
 *           concurrency?: number }} input
 */
export async function markSwaps({ fetchReceipt, transfers, budget, concurrency = 4 }) {
  const verdicts = new Map();
  for (const t of transfers) if (known(t.swapped)) verdicts.set(t.tx, t.swapped);
  const newest = new Map();
  for (const t of transfers) if (!verdicts.has(t.tx)) newest.set(t.tx, Math.max(newest.get(t.tx) ?? -1, t.block ?? 0));
  const pending = [...newest.keys()].sort((a, b) => newest.get(b) - newest.get(a));
  const checked = pending.slice(0, Math.max(0, budget.left));
  if (checked.length < pending.length) budget.exhausted = true;
  budget.left -= checked.length;

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
