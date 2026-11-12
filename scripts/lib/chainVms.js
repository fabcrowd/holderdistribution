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

/**
 * vms whose reads can be pinned to a day-boundary block; the rest read "live" (unsettled).
 * Hedera: a mirror snapshot at or before the block's end, settled forward by replay (lib/hedera/settle.js).
 */
const BLOCK_PINNED_VMS = new Set(["evm", "hedera"]);
export const vmPinsToBlock = (vm) => BLOCK_PINNED_VMS.has(assertChainVm(vm));

/**
 * vms whose scan runs forward from the checkpoint's block, so a checkpoint already past the settled block
 * cannot be read at it. Hedera reads a whole snapshot at any past time, so its checkpoint never blocks a pin.
 */
const FORWARD_SCAN_VMS = new Set(["evm"]);
export const vmScansForwardFromCheckpoint = (vm) => FORWARD_SCAN_VMS.has(assertChainVm(vm));

/** vms whose chains[] entry declares `asset: { kind: "native", decimals }` instead of `tokens[]`. */
const NATIVE_ASSET_VMS = new Set(["hedera"]);
export const vmUsesNativeAsset = (vm) => NATIVE_ASSET_VMS.has(assertChainVm(vm));

/** Chain-entry fields only one vm understands; a derived chain copies them through, any other vm rejects them. */
export const VM_CHAIN_FIELDS = Object.freeze({ hedera: Object.freeze(["mirrorUrl", "rangeWidth", "holderFloorTinybar"]) });
