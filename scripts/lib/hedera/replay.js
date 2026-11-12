/**
 * Apply Hedera HBAR transfer legs to a balance map.
 *
 * Not called by the nightly scan yet. Once a pinned baseline exists, a night's
 * catch-up is this function over that day's transactions, not another full
 * /balances scan. The caller passes transactions in consensus order.
 *
 * `transfers` is the complete HBAR movement of a transaction, fees included,
 * whatever its result: a failed transaction still charges its fee, and the
 * mirror lists only those fee legs for it (measured 2026-11-11: WRONG_NONCE and
 * INVALID_SIGNATURE rows carry a payer leg and a fee leg summing to 0), so every
 * transaction is applied. Staking rewards are already inside `transfers`, netted into the
 * rewarded account's single leg with 0.0.800 debited, so `staking_reward_transfers` is
 * never applied. It is informational and not used as a check: on mainnet it can differ
 * from the 0.0.800 debit by a tinybar (1794439266.363124104: reward 16111538460, debit
 * 16111538459) while `transfers` balances. `transfers` is what moves balances.
 */
const ID_RE = /^0\.0\.[1-9]\d{0,15}$/;

const legAmount = (leg, what) => {
  if (!leg || !ID_RE.test(leg.account) || leg.amount === undefined || leg.amount === null) {
    throw new Error(`${what} has an unreadable HBAR leg`);
  }
  return { account: leg.account, amount: BigInt(leg.amount) };
};

/**
 * @param {Map<string, bigint>} balances account id to tinybar balance
 * @param {Array<{ result?: string, consensus_timestamp?: string, transfers?: unknown[], staking_reward_transfers?: unknown[] }>} transactions
 * @returns {Map<string, bigint>} a new map; `balances` is not changed
 */
export function applyHbarTransfers(balances, transactions) {
  const next = new Map(balances);
  for (const tx of transactions) {
    const when = tx?.consensus_timestamp ?? "(no timestamp)";
    if (!tx || !Array.isArray(tx.transfers)) throw new Error(`transaction ${when} has no transfers array`);
    const legs = tx.transfers.map((leg) => legAmount(leg, `transaction ${when}`));
    const sum = legs.reduce((total, leg) => total + leg.amount, 0n);
    if (sum !== 0n) throw new Error(`transfers of ${when} sum to ${sum}, not 0`);
    for (const leg of legs) next.set(leg.account, (next.get(leg.account) ?? 0n) + leg.amount);
  }
  return next;
}
