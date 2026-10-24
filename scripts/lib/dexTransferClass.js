/**
 * Classify a TEL transfer against a DEX pool/vault as a swap vs LP add/remove
 * by inspecting co-occurring events on the same transaction receipt.
 *
 * Returns: "lp" | "swap" | "unknown"
 * - lp: Balancer PoolBalanceChanged, Uniswap/QuickSwap Mint/Burn
 * - swap: Balancer/Uniswap/QuickSwap Swap event present (and no LP event)
 * - unknown: neither recognisable (caller should default carefully)
 */

// Balancer V2 Vault
const BALANCER_SWAP =
  "0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b";
const BALANCER_POOL_BALANCE_CHANGED =
  "0xe5ce249087ce04f05a957192435400fd97868dba0e6a4b4c049abf8af80dae78";

// Uniswap V2 / QuickSwap V2
const UNI_V2_SWAP =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const UNI_V2_MINT =
  "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
const UNI_V2_BURN =
  "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

// Uniswap V3
const UNI_V3_SWAP =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const UNI_V3_MINT =
  "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
const UNI_V3_BURN =
  "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";

const LP_TOPICS = new Set([
  BALANCER_POOL_BALANCE_CHANGED,
  UNI_V2_MINT,
  UNI_V2_BURN,
  UNI_V3_MINT,
  UNI_V3_BURN,
]);

/** LP event topic0s, for a bulk eth_getLogs pre-classification (see generate-tier-outflows). */
export const LP_EVENT_TOPICS = Object.freeze([...LP_TOPICS]);

const SWAP_TOPICS = new Set([
  BALANCER_SWAP,
  UNI_V2_SWAP,
  UNI_V3_SWAP,
]);

/**
 * @param {Array<{ topics?: string[] }>|null|undefined} logs
 * @returns {"lp"|"swap"|"unknown"}
 */
export const classifyReceiptLogs = (logs) => {
  let hasLp = false;
  let hasSwap = false;
  for (const log of logs ?? []) {
    const t0 = (log?.topics?.[0] ?? "").toLowerCase();
    if (LP_TOPICS.has(t0)) hasLp = true;
    if (SWAP_TOPICS.has(t0)) hasSwap = true;
  }
  // A join/exit can include internal swaps in the same tx on some routers —
  // prefer LP when both fire, since the user's intent was liquidity.
  if (hasLp) return "lp";
  if (hasSwap) return "swap";
  return "unknown";
};

/**
 * Map a receipt classification to the tier-outflow sub-keys.
 * Unknown defaults to swap (historical behaviour treated all DEX as swaps).
 * @param {"lp"|"swap"|"unknown"} kind
 * @returns {"dexLp"|"dexSwap"}
 */
export const dexSubClass = (kind) => (kind === "lp" ? "dexLp" : "dexSwap");
