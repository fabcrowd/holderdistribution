/**
 * The set of chain VMs and the facts about them that shared code needs
 * synchronously (no adapter load). Import-free on purpose so low-level
 * modules (address.js, asOf.js) can use it without pulling in rpc code.
 * Adapter behaviour (scans, clocks, explorer links) lives in chainAdapters.js.
 */
export const CHAIN_VMS = Object.freeze(["evm", "solana", "hedera"]);

/** Throws for a vm that has no adapter, so an unknown vm can never pass as EVM or Solana. */
export function assertChainVm(vm) {
  if (!CHAIN_VMS.includes(vm)) throw new Error(`unknown chain vm ${JSON.stringify(vm)} (supported: ${CHAIN_VMS.join(", ")})`);
  return vm;
}

/** The vm of one chains[] entry: explicit `vm`, else "solana" for key "solana", else "evm". Not validated. */
export function resolveChainVm(chain) {
  if (chain?.vm) return chain.vm;
  if (chain?.key === "solana") return "solana";
  return "evm";
}

/** vms whose live reads can be pinned to a day-boundary block; the rest read "live" (unsettled). */
const BLOCK_PINNED_VMS = new Set(["evm"]);
export const vmPinsToBlock = (vm) => BLOCK_PINNED_VMS.has(assertChainVm(vm));
