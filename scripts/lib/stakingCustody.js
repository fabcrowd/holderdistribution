/**
 * Staking custody reconciliation.
 *
 * A staking contract holds real tokens on chain. Once those tokens are
 * attributed to the individual stakers who own them, the contract's own balance
 * must be reduced by the attributed amount — otherwise the same tokens are
 * counted twice in any chain total or supply figure.
 *
 * This is NOT the same bug as the applyStaking() double-count (which added
 * staking into an already-staking-inclusive balance during aggregation). This
 * one is upstream: the contract was excluded from the RETAIL holder set but left
 * in the chain balance map, so its custodied TEL still contributed to the chain
 * sum on top of the stakers it had been attributed to.
 *
 * Observed impact before the fix: Polygon reported 41,180,472,419 TEL against an
 * on-chain totalSupply() of 37,248,867,603 — a ~3.93B overstatement that
 * surfaced as a phantom ~4B `mirrorResidual`, implying the Polygon bridge was
 * under-collateralised when it is in fact fully backed.
 */

/**
 * Balance the custody contract should retain after attribution.
 *
 * Subtracting (rather than zeroing) is deliberate: attribution is not always
 * complete — a staker who never personally transacted with the contract can be
 * missed — and whatever could not be placed with an owner must stay on the
 * contract so it is still counted exactly once rather than disappearing from
 * supply. Floors at 0 so an over-attribution can never produce a negative
 * balance; the caller warns separately when attribution exceeds custody.
 *
 * @param {number} contractBalance tokens actually held by the custody contract
 * @param {number} attributed total credited to individual stakers
 * @returns {number} balance the contract should retain
 */
export const residualCustodyBalance = (contractBalance, attributed) => {
  const held = Number(contractBalance);
  const placed = Number(attributed);
  if (!Number.isFinite(held) || held <= 0) return 0;
  if (!Number.isFinite(placed) || placed <= 0) return held;
  return Math.max(0, held - placed);
};

/**
 * Moves a staking contract's custodied tokens onto the stakers who own them.
 *
 * Used for the TEL v3 StakingModule (Polygon 0x573105be…5731). It is an
 * ERC-20-style receipt token: staking mints receipts 1:1 to the staker, a
 * withdrawal burns them, so replaying the module's OWN Transfer logs gives each
 * staker's position exactly (on 2026-10-23: 829 holders summing to the
 * module's totalSupply() of 2,991,605,169.62, equal to the v3 TEL it held).
 * Before this, the whole ~3B sat on the module's address and was published as
 * ONE retail wallet in the 500M+ tier.
 *
 * Mutates `balances` (address -> TEL) and, when given, `v3Balances` (the v3
 * share of each balance, which the staked TEL is). Whatever is not attributed
 * (pending withdrawals, rewards) stays on the contract, counted once, via
 * residualCustodyBalance; attribution above custody is clamped and reported.
 *
 * @param {Map<string, number>} balances
 * @param {string} custody custody contract address (lowercase)
 * @param {Map<string, number>} receipts staker -> staked TEL
 * @param {Map<string, number>} [v3Balances]
 * @returns {{ held: number, attributed: number, residual: number, stakers: number, overAttributed: number }}
 */
export const attributeStakingReceipts = (balances, custody, receipts, v3Balances = null) => {
  const held = Number(balances.get(custody) ?? 0);
  let attributed = 0;
  let stakers = 0;
  for (const [account, amount] of receipts) {
    if (account === custody || !Number.isFinite(amount) || amount <= 0) continue;
    attributed += amount;
    stakers++;
  }
  // Over-attribution would invent TEL: scale every position down to what the
  // contract really holds (never expected; the caller logs it if it happens).
  const scale = attributed > held && attributed > 0 ? held / attributed : 1;
  let placed = 0;
  for (const [account, amount] of receipts) {
    if (account === custody || !Number.isFinite(amount) || amount <= 0) continue;
    const credit = amount * scale;
    balances.set(account, (balances.get(account) ?? 0) + credit);
    if (v3Balances) v3Balances.set(account, (v3Balances.get(account) ?? 0) + credit);
    placed += credit;
  }
  const residual = residualCustodyBalance(held, placed);
  if (held > 0 || balances.has(custody)) balances.set(custody, residual);
  if (v3Balances && v3Balances.has(custody)) {
    v3Balances.set(custody, residualCustodyBalance(v3Balances.get(custody), placed));
  }
  return { held, attributed: placed, residual, stakers, overAttributed: Math.max(0, attributed - held) };
};
