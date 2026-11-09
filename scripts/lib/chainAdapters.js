/**
 * Chain adapter registry (approach A, docs/superpowers/specs/2026-10-25-solana-chain-support-design.md).
 *
 * Every `chains[]` entry resolves a `vm` ("evm" by default). The registry maps
 * a vm to an adapter with one interface:
 *
 *   health(chain)                      -> usable RPC URLs (throws when none)
 *   tokenMeta(chain, token)            -> { symbol, name, decimals, supply }
 *   scanHolders(chain, token, opts)    -> { holders: [{ address, balance, raw }], ... }
 *   explorerUrl(chain, kind, id)       -> kind "token" | "address" | "tx"
 *   normalizeAddress(chain, address)   -> canonical address or null
 *   isAddress(chain, address)          -> true for a valid address of this vm
 *   clock(chain)                       -> { firstAtOrAfter(targetTs, getTime, low, high) }, the vm's
 *                                         block/slot search used for day cutoffs
 *
 * The EVM adapter is in-process and cheap. The Solana and Hedera adapters live under
 * scripts/lib/solana/ and scripts/lib/hedera/ and are only ever imported through loadChainAdapter,
 * which callers reach only when a project actually lists such a chain.
 * Nothing here imports them statically, so an EVM-only project (TEL) never
 * loads a byte of Solana or Hedera code.
 */
import { isAddressForVm, normalizeAddressForVm } from "./address.js";
import { assertChainVm, CHAIN_VMS, resolveChainVm } from "./chainVms.js";
import { findFirstBlockAtOrAfter } from "./dayBlocks.js";
import { getUsableRpcUrls } from "./rpc.js";

export { CHAIN_VMS, resolveChainVm };
export const BRIDGE_MODES = Object.freeze(["native", "lock-mint", "burn-mint"]);
export const SOLANA_CLUSTERS = Object.freeze(["mainnet-beta"]);

/** The bridge mode of one chains[] entry (default "native"). */
export const resolveChainBridge = (chain) => chain?.bridge ?? "native";

/** True when the project config lists at least one chain with this vm. */
export const projectHasVm = (config, vm) => (config?.chains ?? []).some((c) => resolveChainVm(c) === vm);

/** Default explorer URL templates per vm. EVM reproduces today's `/token/` and `/address/` links. */
export function defaultExplorerTemplates(chain) {
  const vm = resolveChainVm(chain);
  if (vm === "solana") {
    const root = (chain?.explorer ?? "https://solscan.io").replace(/\/+$/, "");
    return { token: `${root}/token/{address}`, address: `${root}/account/{address}`, tx: `${root}/tx/{tx}` };
  }
  const root = (chain?.explorer ?? "").replace(/\/+$/, "");
  if (!root) return {};
  return { token: `${root}/token/{address}`, address: `${root}/address/{address}`, tx: `${root}/tx/{tx}` };
}

/**
 * Explorer link for a chain entry. `chains[].explorerTemplates` wins per kind;
 * otherwise the vm default. EVM addresses are lowercased exactly as the
 * pipeline always did; Solana addresses keep their case.
 */
export function chainExplorerUrl(chain, kind, id) {
  const templates = { ...defaultExplorerTemplates(chain), ...(chain?.explorerTemplates ?? {}) };
  const template = templates[kind];
  if (!template || typeof id !== "string") return null;
  const value = kind === "tx" ? id.trim() : (normalizeAddressForVm(resolveChainVm(chain), id) ?? id.trim());
  return template.replaceAll("{address}", value).replaceAll("{tx}", value);
}

const evmAdapter = {
  vm: "evm",
  async health(chain) {
    return getUsableRpcUrls(chain.key);
  },
  normalizeAddress: (_chain, address) => normalizeAddressForVm("evm", address),
  isAddress: (_chain, address) => isAddressForVm("evm", address),
  clock: () => ({ firstAtOrAfter: findFirstBlockAtOrAfter }),
  explorerUrl: chainExplorerUrl,
  // EVM holder scans stay in pull-holders-rpc.js (Transfer-log replay with
  // checkpoints, v3 netting and staking attribution). They are unchanged by
  // this registry; the dispatcher keeps calling them directly.
  async tokenMeta() {
    throw new Error("evm adapter: token metadata is read by the existing EVM pipeline (pull-holders-rpc / tokenChains.probeToken)");
  },
  async scanHolders() {
    throw new Error("evm adapter: holder scans run in pull-holders-rpc.js (Transfer-log replay)");
  },
};

const loaded = new Set();

/** vms whose adapter module has been loaded in this process (test hook). */
export const loadedAdapterVms = () => [...loaded];

/**
 * The adapter for a vm. The Solana and Hedera modules are imported lazily, here only, so
 * they are never loaded for a project without such a chain.
 */
export async function loadChainAdapter(vm) {
  if (vm === "evm") {
    loaded.add("evm");
    return evmAdapter;
  }
  if (vm === "solana") {
    const mod = await import("./solana/adapter.js");
    loaded.add("solana");
    return mod.solanaAdapter;
  }
  if (vm === "hedera") {
    const mod = await import("./hedera/adapter.js");
    loaded.add("hedera");
    return mod.hederaAdapter;
  }
  assertChainVm(vm);
  throw new Error(`chain vm ${JSON.stringify(vm)} has no adapter loader`);
}

/** Adapter for a chains[] entry. */
export const adapterForChain = (chain) => loadChainAdapter(resolveChainVm(chain));
