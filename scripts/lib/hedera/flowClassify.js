/**
 * Classifies one Hedera mirror transaction against a project's exchange (CEX) accounts.
 *
 * HBAR only. `transfers` is the complete tinybar movement of one record (the same
 * field replay.js applies to balances), so each record is counted once, keyed by
 * its consensus timestamp:
 *
 *   - Child records (nonce > 0, parent_consensus_timestamp) and scheduled
 *     executions (scheduled: true) are separate mirror rows with their own
 *     `transfers`; a parent's `transfers` never repeats them. Counting every row
 *     once therefore never double-counts, and it is the same rule that reproduces
 *     snapshot balances to the tinybar (settle.js).
 *   - Fees: the payer (the account of `transaction_id`) is debited `charged_tx_fee`
 *     inside its one leg and the fee sink accounts are credited it. The fee is
 *     added back to the payer's leg and the same amount is removed from the sink
 *     credits, so a fee is never an exchange flow.
 *   - A failed transaction moves only fee legs, so after the fee adjustment it
 *     leaves no flow (nothing is keyed on the result text: the legs decide).
 *   - Staking rewards are netted into the rewarded account's own leg and debited
 *     from 0.0.800. They are removed from the rewarded account and from 0.0.800.
 *     A single rewarded account's reward is the exact 0.0.800 debit;
 *     `staking_reward_transfers` amounts are only used when several accounts are
 *     rewarded in one record, because that list can differ from the debit by a
 *     tinybar (replay.js).
 *   - Older eras also credited a fee share to 0.0.800. When 0.0.800 is net negative
 *     that share is netted inside its debit, so the debit understates the single
 *     reward by exactly the fee left unmatched by the sink loop. That remainder is
 *     added back to the reward (audit.rewardPoolFeeShare) so an exchange that
 *     receives its own reward inside a deposit is not overstated. A record whose
 *     fee is unmatched for any other reason is indistinguishable here; it is
 *     counted in the audit (feeMatched false) and a reward in it can be off by
 *     at most that unmatched remainder (a few tinybar in the observed eras).
 *   - The adjusted legs are paired (largest against largest) into transfers, as
 *     the Solana scan does. A transfer between two accounts of one exchange is
 *     `internal`; between two exchanges it is a withdrawal for one and a
 *     deposit for the other. In a record with several senders and several
 *     receivers the counterparty pairing is greedy largest-to-largest: per-exchange
 *     totals are exact, but which counterparty (and therefore which tier) a
 *     deposit is credited to is a convention.
 *   - Which account's scan counts a record that touches several exchange accounts
 *     is `canonicalOwner`: the lowest account id with a leg, independent of config
 *     order. It still depends on WHICH accounts are configured, so the scan stamps
 *     FLOW_CLASSIFIER_VERSION and the account set into its checkpoint and rebuilds
 *     when either changes (flowConfig.js flowSetHash / planFlowResume).
 */
import { pairTransfers } from "../solana/flowScan.js";

/** Bump when a change here alters what a record classifies to; a stored scan then rebuilds. */
export const FLOW_CLASSIFIER_VERSION = 2;

const REWARD_POOL = "0.0.800";
/** Fee sinks are system accounts (nodes 0.0.3.., 0.0.98, 0.0.800-802). */
const SYSTEM_ACCOUNT_MAX = 1000;
const ID_RE = /^0\.0\.[1-9]\d{0,15}$/;
const num = (id) => Number(id.slice(4));

function deltasOf(tx) {
  const when = tx?.consensus_timestamp ?? "(no timestamp)";
  if (!tx || !Array.isArray(tx.transfers)) throw new Error(`hedera transaction ${when} has no transfers array`);
  const deltas = new Map();
  for (const leg of tx.transfers) {
    if (!leg || !ID_RE.test(leg.account) || leg.amount === undefined || leg.amount === null) throw new Error(`hedera transaction ${when} has an unreadable HBAR leg`);
    deltas.set(leg.account, (deltas.get(leg.account) ?? 0n) + BigInt(leg.amount));
  }
  return deltas;
}

/**
 * The lowest account id of `accounts` that has an HBAR leg in `tx`, or null. Decides which account's scan
 * counts the record. Independent of the order of `accounts` (config order must never change what is stored).
 */
export function canonicalOwner(tx, accounts) {
  const ids = new Set((tx?.transfers ?? []).map((leg) => leg.account));
  let best = null;
  for (const id of accounts) {
    if (!ids.has(id)) continue;
    if (best === null || BigInt(id.slice(4)) < BigInt(best.slice(4))) best = id;
  }
  return best;
}

/**
 * @param {object} tx mirror /transactions row
 * @param {{ cex: Map<string, string> }} roles account id to exchange name
 * @returns {{ events: Array<{kind: string, venue: string, counterparty: string|null, raw: string}>, audit: object }}
 */
export function classifyHederaTx(tx, roles) {
  const deltas = deltasOf(tx);
  const audit = { fee: 0n, feeMatched: true, reward: 0n, rewardResidual: 0n, rewardPoolFeeShare: 0n, cexLegs: 0 };
  if (![...deltas.keys()].some((id) => roles.cex.has(id))) return { events: [], audit };

  const adj = new Map(deltas);
  let feeLeft = 0n;
  const fee = BigInt(tx.charged_tx_fee ?? 0);
  const payer = String(tx.transaction_id ?? "").split("-")[0];
  if (fee > 0n && adj.has(payer)) {
    adj.set(payer, adj.get(payer) + fee);
    let left = fee;
    for (const [id, amount] of adj) {
      if (left === 0n) break;
      if (id === payer || amount <= 0n || num(id) > SYSTEM_ACCOUNT_MAX || roles.cex.has(id)) continue;
      const take = amount < left ? amount : left;
      adj.set(id, amount - take);
      left -= take;
    }
    audit.fee = fee;
    audit.feeMatched = left === 0n;
    feeLeft = left;
  }

  const rewards = (tx.staking_reward_transfers ?? []).filter((r) => adj.has(r.account));
  if (rewards.length > 0 && adj.has(REWARD_POOL)) {
    const debit = -adj.get(REWARD_POOL);
    const listed = (tx.staking_reward_transfers ?? []).length;
    for (const r of rewards) {
      const amount = listed === 1 ? debit + feeLeft : BigInt(r.amount);
      adj.set(r.account, adj.get(r.account) - amount);
      audit.reward += amount;
    }
    if (listed === 1) audit.rewardPoolFeeShare = feeLeft;
    adj.delete(REWARD_POOL);
    audit.rewardResidual = [...adj.values()].reduce((a, b) => a + b, 0n);
  }

  for (const [id, amount] of adj) if (amount === 0n) adj.delete(id);
  const events = [];
  for (const { from, to, raw } of pairTransfers(adj)) {
    const fromEx = from === null ? undefined : roles.cex.get(from);
    const toEx = to === null ? undefined : roles.cex.get(to);
    if (fromEx === undefined && toEx === undefined) continue;
    const amount = raw.toString();
    if (fromEx !== undefined && toEx !== undefined && fromEx === toEx) events.push({ kind: "internal", venue: toEx, counterparty: from, raw: amount });
    else {
      if (fromEx !== undefined) events.push({ kind: "cexOut", venue: fromEx, counterparty: to, raw: amount });
      if (toEx !== undefined) events.push({ kind: "cexIn", venue: toEx, counterparty: from, raw: amount });
    }
  }
  audit.cexLegs = [...deltas.keys()].filter((id) => roles.cex.has(id)).length;
  return { events, audit };
}
