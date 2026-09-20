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
