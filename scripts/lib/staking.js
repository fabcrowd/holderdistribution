import { keccak256 } from "ethereum-cryptography/keccak";
import { utf8ToBytes } from "ethereum-cryptography/utils";

/** 4-byte function selector for a Solidity signature, e.g. "stakedBy(address)". */
export const selector = (signature) => "0x" + Buffer.from(keccak256(utf8ToBytes(signature))).toString("hex").slice(0, 8);

/** Full 32-byte event-topic hash for a Solidity event signature — unlike `selector`, not truncated. */
export const topicHash = (signature) => "0x" + Buffer.from(keccak256(utf8ToBytes(signature))).toString("hex");

export const STAKED_BY_SELECTOR = selector("stakedBy(address)");
export const TOTAL_STAKED_SELECTOR = selector("totalStaked()");

/**
 * StakeChanged(address indexed account, uint256 oldStake, uint256 newStake) —
 * the staking contract implementation's own record of every account whose
 * stake ever changed, fetched from its verified ABI on Etherscan
 * (implementation 0x63a941972f9398d002ccf6c3f69aa97dab3dd79e, proxy
 * 0x92e43aec...6330). Unlike ERC-20 Transfer logs, this fires with the TRUE
 * beneficiary account regardless of who paid gas or moved tokens — so
 * stakeFor()/claimAndExitFor() beneficiaries who never personally
 * transacted with the contract are correctly captured. Confirmed
 * empirically 2026-08-11: scanning this event surfaced 6,709 unique
 * accounts vs 6,146 via Transfer-log discovery (+9.2%), matching the
 * direction and magnitude of the 8.41% (352.3M TEL) reconciliation gap
 * Transfer-log discovery left unexplained. See pull-staker-balances.js.
 */
export const STAKE_CHANGED_TOPIC0 = topicHash("StakeChanged(address,uint256,uint256)");

/** Extracts the indexed `account` address from a StakeChanged log's topics[1]. */
export const parseStakeChangedAccount = (log, normalize) => {
  const topic = log?.topics?.[1];
  if (typeof topic !== "string" || topic.length < 40) return null;
  return normalize(`0x${topic.slice(-40)}`);
};

/**
 * Parses a full StakeChanged(address indexed account, uint256 oldStake,
 * uint256 newStake) log, including both non-indexed data words — not just
 * the account. Per standard Solidity ABI encoding, non-indexed event
 * parameters are packed into `data` in DECLARATION order, so word 0
 * (bytes 0-31) is `oldStake` and word 1 (bytes 32-63) is `newStake`.
 *
 * THIS ORDERING IS A HYPOTHESIS, NOT A VERIFIED FACT — verify-staker-methods.js
 * checks it independently before anything depends on it: on any account's
 * *earliest* event, `oldStake` must be exactly 0 (nobody's first stake
 * follows a nonzero prior balance). If that check fails, the words are
 * swapped from what's assumed here and this function must be corrected
 * before it's trusted. (The orphaned scripts/pull-staker-balances-rpc.js
 * reads word 0 as `newStake` — the opposite of declaration order — which is
 * exactly the kind of assumption this check exists to catch, not inherit.)
 *
 * Returns null for a malformed log (missing account, or data shorter than
 * two 32-byte words).
 */
export const parseStakeChangedEvent = (log, normalize) => {
  const account = parseStakeChangedAccount(log, normalize);
  if (!account) return null;
  const data = typeof log?.data === "string" ? log.data.replace(/^0x/, "") : "";
  if (data.length < 128) return null;
  const oldStake = BigInt(`0x${data.slice(0, 64)}`);
  const newStake = BigInt(`0x${data.slice(64, 128)}`);
  const blockNumber = typeof log?.blockNumber === "string"
    ? Number.parseInt(log.blockNumber, 16)
    : Number(log?.blockNumber ?? NaN);
  const logIndex = typeof log?.logIndex === "string"
    ? Number.parseInt(log.logIndex, 16)
    : Number(log?.logIndex ?? 0);
  if (!Number.isFinite(blockNumber)) return null;
  return { account, oldStake, newStake, blockNumber, logIndex: Number.isFinite(logIndex) ? logIndex : 0 };
};

/** ABI-encodes calldata for a single-address-argument view call. */
export const encodeAddressCall = (sig, address) => {
  const addr = address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return `${selector(sig)}${addr}`;
};

/** Decodes a uint256 eth_call result (hex string) to a JS number, given raw decimals. */
export const decodeUint256 = (hex) => {
  if (!hex || hex === "0x") return 0;
  return Number(BigInt(hex));
};

// Transfer-log net reconstruction (summing in/out per address) silently
// breaks whenever a deposit or withdrawal routes through a different address
// than the staker's own account, which this contract explicitly supports via
// `stakeFor(address, uint256)` and `claimAndExitFor(address, address,
// bytes)` — verified via the implementation contract's ABI (proxy
// 0x92e43aec...6330, implementation 0x63a94197...dd79e). Confirmed
// empirically 2026-08-07: transfer-log netting overstated total staked by
// ~505.7M TEL (12.1%) against the contract's own totalStaked(), while the
// aggregate in-minus-out (address-agnostic) matched to within 0.2% — proving
// the loss was purely a per-address attribution problem, not a missing/extra
// transfer. stakedBy(address), read directly from the contract's own
// accounting, is authoritative and immune to this. (Candidate discovery
// itself moved off Transfer logs too, to StakeChanged — see above.)
