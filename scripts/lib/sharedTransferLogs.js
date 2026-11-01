/**
 * Serves Transfer logs from a shared window when it covers the requested range,
 * and falls back to the caller's RPC fetch otherwise. Named apart from logSource.js,
 * which is a different module.
 *
 * HD_SHARED_SCAN=off bypasses the window entirely, so a bad window can be ruled
 * out by flipping one env var without changing code.
 */

import process from "node:process";
import { sliceWindow, windowConfigHash, TRANSFER_TOPIC0 } from "./transferWindow.js";

export const sharedScanEnabled = (env = process.env) => env.HD_SHARED_SCAN !== "off";

/**
 * Logs for [fromBlock, toBlock] from `window` when it is enabled, covers the range
 * and was built for the same chain, tokens and topics. Otherwise calls `fetchFromRpc`
 * and returns its result. Errors from `fetchFromRpc` propagate unchanged.
 */
export async function getTransferLogsCached({
  window,
  chain,
  tokens,
  fromBlock,
  toBlock,
  fetchFromRpc,
  topics = [TRANSFER_TOPIC0],
  env = process.env,
}) {
  if (sharedScanEnabled(env) && window) {
    const sliced = sliceWindow(window, fromBlock, toBlock, windowConfigHash(chain, tokens, topics));
    if (sliced !== null) return sliced;
  }
  return fetchFromRpc();
}
