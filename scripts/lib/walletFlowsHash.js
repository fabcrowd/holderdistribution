/**
 * State hash for the EVM wallet-flows scan (generate-wallet-flows.js), split from walletFlowsState.js.
 *
 * The stored state is, per chain, a cursor, the decoded outflow events of the watched senders and
 * per event a swap verdict (`swapped`, `swapAttempts`, `swapCheck`). What decides that data:
 *   - which logs are requested: token contracts (+ decimals/slots) and the sender set;
 *   - how a verdict is read from a receipt: SWAP_TOPICS (and the logic version).
 * `minCandidateTel` is kept too (conservative: a changed threshold rescans once).
 *
 * Everything else only labels events when the report is built, so it is NOT hashed:
 *   - recon categories, CEX list, DEX list, upgrade contracts, bridges, registry labels / notes /
 *     entity classes / watched sellers. Seller discovery (72h) is recomputed every run, not stored.
 *   - Receipt checks are chosen on every run from the CURRENT labels (`swapCandidates`) over the
 *     whole merged store, and a stored true/false verdict is a receipt fact (a "gave-up" verdict is not:
 *     it is retried with leftover receipt budget, see walletFlowsSwaps.js). An address newly unlabelled
 *     (e.g. dropped from the DEX list) gets its events checked on the next run (absent verdict =
 *     retried, newest first, within the receipt budget); a newly labelled one is simply not
 *     checked, and its stored verdict, if any, stays true of the receipt. So no label change can
 *     make the stored state wrong, and none needs a rescan.
 */
import { configHash } from "./walletFlowsState.js";
import { norm } from "./walletFlows.js";

/** Addresses whose outflows are fetched (topic1 filter): registry known wallets + bot cluster. */
export const senderAddresses = (registry) =>
  [...new Set([...(registry.knownWallets ?? []).map((w) => norm(w.address)), ...(registry.botCluster?.addresses ?? []).map(norm)])].sort();

/** Hash of the inputs that decide the stored scan data (see the header). */
export const scanHash = ({ logic, registry, tokens }) => configHash({ scan: 2, logic, senders: senderAddresses(registry), tokens });

/**
 * The hash format before the scan-only change, kept ONLY to adopt a state whose inputs are provably
 * unchanged (see adoptLegacyState). Do not change; remove once every stored state has been rewritten.
 */
export const legacyScanHash = ({ logic, registry, cexWallets, dexAddresses, upgradeContracts, bridgeAddresses, reconItems, tokens }) =>
  configHash({
    logic,
    registry,
    cex: cexWallets.map((w) => [norm(w.address), w.label ?? w.walletName ?? null]),
    dexAddresses: dexAddresses.map(norm).sort(),
    upgradeContracts: upgradeContracts.map(norm).sort(),
    bridgeAddresses: bridgeAddresses.map(norm).sort(),
    recon: reconItems.map((i) => [norm(i.address), i.category]).sort(),
    tokens,
  });

/**
 * A state stored under the old hash is still valid when that hash equals the old-format hash of the
 * CURRENT inputs: nothing changed under the old rule, so nothing changed under the (narrower) new one.
 * Returns the state re-stamped with the new hash; any other mismatch is returned untouched (rescan).
 */
export function adoptLegacyState(state, { hash, legacyHash }) {
  if (!state || typeof state !== "object" || state.configHash === hash || state.configHash !== legacyHash) {
    return { state, adopted: false };
  }
  return { state: { ...state, configHash: hash }, adopted: true };
}
