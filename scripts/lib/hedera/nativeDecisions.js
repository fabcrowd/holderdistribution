/**
 * The owner's judgement for the HBAR native coin that the onboarding runner needs and that a
 * token onboarded through an answers file keeps in config/projects/<slug>/onboarding.answers.json.
 * The shape is that file's own (scripts/lib/onboardAnswers.js, onboarding-answers/1): `historyStart`
 * and `largeHolders[]` rows, so the runner reads one format whether the record is committed or comes
 * from this port. The wallet decisions (treasury ranges, WHBAR role, CEX list) are not repeated here:
 * they are already data in exclusions.json, contracts{} and cex-wallets.json (treasury.js, cexAccounts.js).
 *
 * largeHolders rows go through the normal megaHolderThreshold lifecycle (lib/onboardRun.js): an
 * acknowledged retail account above the threshold raises it by derivation, never by a hand-set number.
 */
export const HEDERA_CHAIN_KEY = "hedera";

const FORWARD_ONLY_EVIDENCE =
  "Owner decision 2026-11-11 (tasks/hedera-plan.md slice 6): HBAR history starts at the first settled nightly snapshot; a transaction replay to 2019 was measured and declined.";

/**
 * Accounts above 1% of supply that the owner has decided. Anything else above 1% blocks the runner's large-holders step.
 * A traced account whose identity cannot be established is recorded with decision "unknown" (it counts as a holder, like "retail").
 */
export const HEDERA_LARGE_HOLDERS = Object.freeze([
  Object.freeze({
    chain: HEDERA_CHAIN_KEY,
    address: "0.0.640701",
    decision: "retail",
    note: "Owner decision 2026-11-11: about 3.14B HBAR, unidentified, no exchange or treasury evidence; stays retail (tasks/hedera-plan.md slice 7a).",
  }),
  Object.freeze({
    chain: HEDERA_CHAIN_KEY,
    address: "0.0.10253638",
    decision: "unknown",
    note: "Owner decision 2026-11-13: ~923M HBAR (1.85%), created 2026-02-01, single ED25519 key, no staking, periodic inbound from 0.0.9200427; traced, identity not established, no exchange/treasury evidence. Counts as a holder.",
  }),
  Object.freeze({
    chain: HEDERA_CHAIN_KEY,
    address: "0.0.8490652",
    decision: "unknown",
    note: "Owner decision 2026-11-13: ~781M HBAR (1.56%), created 2025-03-14, staked to node 20, daily inbound from 0.0.9203808 + staking rewards from 0.0.800; traced, identity not established, no exchange/treasury evidence. Counts as a holder.",
  }),
]);

/**
 * nightly.waivers the native coin starts with (config/nightly-jobs.json ids), each with its reason; the parity test
 * (nightlyPlan.test.js) requires every data set to run or be waived. Network staking is the informational tile of
 * owner decision 5 (networkStake.js), so there is no staker-balance data set.
 */
export const hederaNightlyWaivers = () => ({
  "staker-balances": "HBAR has no staking contract: network staking is protocol-level and shown as an informational tile (mirror /network/stake, owner decision 2026-11-08), never subtracted from holders.",
  "history-gaps": "fill-history-gaps.js only repairs EVM block-timestamp gaps; HBAR history is forward-only from its first settled snapshot (owner decision 2026-11-11).",
  "cex-candidates": "detect-cex-candidates.js scans an EVM transfer graph only; HBAR exchange accounts come from proof-of-reserves and reviewed lists (scripts/lib/hedera/cexAccounts.js).",
});

/** supply.circulating.subtract: the owner rule of 2026-11-12 (team and holdings leave circulating on every coin but TEL); HBAR has no separate team or holdings accounts today, so they subtract nothing. */
export const HEDERA_CIRCULATING_SUBTRACT = Object.freeze(["treasury", "holdings", "team"]);

/** Answers-shaped partial record: only the fields the runner reads for a native coin. */
export function hederaNativeDecisions() {
  return {
    historyStart: "forward-only",
    historyEvidence: FORWARD_ONLY_EVIDENCE,
    largeHolders: HEDERA_LARGE_HOLDERS.map((row) => ({ ...row })),
  };
}
