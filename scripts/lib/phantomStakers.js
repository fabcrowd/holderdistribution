/**
 * phantomStakers.js
 *
 * Identifies the synthetic "staker" wallets that the pre-2026-08-07 staking
 * attribution invented, so historical holder counts can be corrected to match
 * how the metric is computed today.
 *
 * WHY THIS EXISTS
 *
 * Until 2026-08-07 the pipeline reconstructed each staker's position by netting
 * Etherscan transfer logs against the Polygon staking contract. That
 * over-attributed heavily: it credited a staked position to any address whose
 * transfer history merely *looked* like a net deposit. Two commits replaced it
 * with direct on-chain `stakedBy()` reads:
 *
 *   2049c06  Fix staking over-attribution: dedup Etherscan transfers per
 *            transfer, not per tx
 *   f60e6fb  Replace staking-attribution transfer-log netting with stakedBy()
 *            reads
 *
 * pull-holders-rpc.js merges every attributed staker into the POLYGON balance
 * map as a holder (`chainBalancesRaw.polygon.set(addr, existing + stakedAmount)`),
 * so each over-attributed wallet also became a phantom Polygon *holder*. The
 * 2026-08-08 snapshot is the first run after the fix, and it drops 1,399 Polygon
 * wallets in one day against a 7-64/day baseline — a ~20x outlier that reads on
 * the /holders chart as a near-vertical cliff.
 *
 * Measured across that boundary:
 *   funding-wallets.json entries   2,834 -> 1,532
 *   attributed stakedAmount        4.672B -> 3.828B
 *   polygon holders               36,299 -> 34,953
 *
 * 1,384 of the 1,399 vanished wallets (98.9%) were entries in the 08-07
 * funding-wallets.json whose Polygon balance was EXACTLY their `stakedAmount` —
 * i.e. the balance was the attribution, not an observed holding. Live Polygon
 * `balanceOf` for the five largest returns 0 for all five (100,000,000 /
 * 100,000,000 / 77,754,190.23 / 69,696,969.69 / 50,000,000 TEL in the snapshot,
 * nothing on chain). The current data is right; the history was inflated.
 *
 * This is NOT a classification problem, which is why the rest of
 * recompute-history-from-git.js cannot fix it: phantom stakers are absent from
 * the non-retail set (0 of 1,399 match it) because they are not exchanges or
 * pools — they are fabricated rows. Reclassifying reproduces them exactly.
 *
 * THE TEST
 *
 * A wallet is phantom on a given date when BOTH hold:
 *   1. it was in that date's funding-wallets.json but is absent from the
 *      current, stakedBy()-derived funding-wallets.json, and
 *   2. its Polygon balance in that date's snapshot equals its attributed
 *      `stakedAmount` (within a cent).
 *
 * Condition 2 is what separates a fabricated row from a real Polygon holder who
 * merely also staked: a real holder's balance is their holdings plus their
 * stake, so it will not land exactly on the stake.
 *
 * KNOWN LIMITATION
 *
 * A wallet that genuinely staked before 2026-08-07, held nothing else on
 * Polygon, and genuinely unstaked before today satisfies both conditions and
 * will be removed from the historical count. Condition 2 keeps this narrow, and
 * `classifySnapshot` reports the count so it can be quantified rather than
 * assumed away. Distinguishing the two cases properly needs `stakedBy()` reads
 * at archived block heights, which requires archive-node access this pipeline
 * does not have.
 */

/** Tolerance for "balance equals the attributed stake". TEL has 2 decimals, so
 *  anything under a cent is float noise from the raw/human conversion. */
const BALANCE_EPSILON = 0.01;

const normalize = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : "";
};

/** Address -> attributed stakedAmount, from a funding-wallets.json document. */
export const stakedAmountsByAddress = (fundingWallets) => {
  const map = new Map();
  for (const wallet of fundingWallets?.wallets ?? []) {
    const address = normalize(wallet?.fundingWallet ?? wallet?.address);
    if (!address) continue;
    const amount = Number(wallet?.stakedAmount);
    if (!Number.isFinite(amount)) continue;
    map.set(address, amount);
  }
  return map;
};

/**
 * Phantom stakers in one historical snapshot.
 *
 * @param {object} snapshot        that date's tel-holders.json
 * @param {Map<string, number>} historicalStakes  that date's attribution
 * @param {Map<string, number>} currentStakes     today's stakedBy()-derived attribution
 * @returns {{ phantoms: Set<string>, ambiguous: number, retained: number }}
 *   `phantoms` are addresses to drop from that date's holder derivation.
 *   `ambiguous` counts wallets dropped from the attribution whose Polygon
 *   balance did NOT equal their stake — real holders we deliberately keep.
 *   `retained` counts wallets still in today's attribution, never candidates.
 */
export const classifySnapshot = (snapshot, historicalStakes, currentStakes) => {
  const polygonBalances = new Map();
  for (const wallet of snapshot?.wallets ?? []) {
    const address = normalize(wallet?.address);
    if (!address) continue;
    const balance = Number(wallet?.polygon_balance);
    if (Number.isFinite(balance) && balance > 0) polygonBalances.set(address, balance);
  }

  const phantoms = new Set();
  let ambiguous = 0;
  let retained = 0;

  for (const [address, stakedAmount] of historicalStakes) {
    if (currentStakes.has(address)) {
      retained += 1;
      continue;
    }
    const balance = polygonBalances.get(address);
    if (balance === undefined) continue;
    if (Math.abs(balance - stakedAmount) < BALANCE_EPSILON) phantoms.add(address);
    else ambiguous += 1;
  }

  return { phantoms, ambiguous, retained };
};
