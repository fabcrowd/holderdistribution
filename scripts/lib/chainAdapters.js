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
 *
 * The EVM adapter is in-process and cheap. The Solana adapter lives under
 * scripts/lib/solana/ and is only ever imported through loadChainAdapter("solana"),
 * which callers reach only when a project actually lists a Solana chain.
 * Nothing here imports it statically, so an EVM-only project (TEL) never
 * loads a byte of Solana code.
 */
import { normalizeAddressForVm } from "./address.js";
import { getUsableRpcUrls } from "./rpc.js";

export const CHAIN_VMS = Object.freeze(["evm", "solana"]);
export const BRIDGE_MODES = Object.freeze(["native", "lock-mint", "burn-mint"]);
export const SOLANA_CLUSTERS = Object.freeze(["mainnet-beta"]);

/** The vm of one chains[] entry: explicit `vm`, else "solana" for key "solana", else "evm". */
export function resolveChainVm(chain) {
  if (chain?.vm) return chain.vm;
  if (chain?.key === "solana") return "solana";
  return "evm";
}

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
 * The adapter for a vm. The Solana module is imported lazily, here only, so
 * it is never loaded for a project without a Solana chain.
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
  throw new Error(`unknown chain vm ${JSON.stringify(vm)} (supported: ${CHAIN_VMS.join(", ")})`);
}

/** Adapter for a chains[] entry. */
export const adapterForChain = (chain) => loadChainAdapter(resolveChainVm(chain));
