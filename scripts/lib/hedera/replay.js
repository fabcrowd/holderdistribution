/**
 * Apply Hedera HBAR transfer legs to a balance map.
 *
 * Not called by the nightly scan yet. Once a pinned baseline exists, a night's
 * catch-up is this function over that day's transactions, not another full
 * /balances scan. The caller passes transactions in consensus order.
 *
 * `transfers` is the complete HBAR movement of a successful transaction, fees
 * included. The mirror also lists staking rewards in `staking_reward_transfers`;
 * those legs are already inside `transfers`, so they are checked and not applied
 * again. A reward leg that is absent from `transfers` rejects the transaction
 * rather than guessing.
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
    if (tx.result !== "SUCCESS") continue;
    const legs = tx.transfers.map((leg) => legAmount(leg, `transaction ${when}`));
    const sum = legs.reduce((total, leg) => total + leg.amount, 0n);
    if (sum !== 0n) throw new Error(`transfers of ${when} sum to ${sum}, not 0`);
    for (const reward of tx.staking_reward_transfers ?? []) {
      const leg = legAmount(reward, `staking reward in ${when}`);
      if (!legs.some((item) => item.account === leg.account && item.amount === leg.amount)) {
        throw new Error(`staking reward for ${leg.account} in ${when} is not in transfers`);
      }
    }
    for (const leg of legs) next.set(leg.account, (next.get(leg.account) ?? 0n) + leg.amount);
  }
  return next;
}
