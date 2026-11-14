/**
 * Explorer link builders, vm-aware (Solana chain support design,
 * docs/superpowers/specs/2026-10-25-solana-chain-support-design.md).
 *
 * - EVM (default): `${explorer}/token/<addr>`, `${explorer}/address/<addr>`,
 *   `${explorer}/tx/<hash>`. Hex addresses are case-insensitive; token links
 *   keep the historical lowercasing where callers already did.
 * - Solana: Solscan by default (`/token/{address}`, `/account/{address}`,
 *   `/tx/{tx}`). Base58 is case-sensitive and is NEVER lowercased.
 * - `explorerTemplates` on a chain overrides either: `{address}` / `{tx}`
 *   placeholders, e.g. "https://explorer.solana.com/address/{address}".
 *
 * - Hedera: HashScan (`/token/{address}`, `/account/{address}`,
 *   `/transaction/{tx}`). Ids are `0.0.N` (not hex), never lowercased.
 *
 * Mirrors scripts/lib/chainAdapters.js chainExplorerUrl().
 */
export type ChainVm = "evm" | "solana" | "hedera";
export type ExplorerKind = "token" | "address" | "tx";
export type ExplorerTemplates = Partial<Record<ExplorerKind, string>>;

export type ExplorerChain = {
  key: string;
  vm?: ChainVm;
  explorer?: string;
  explorerTemplates?: ExplorerTemplates;
};

export const SOLSCAN = "https://solscan.io";
/** Mainnet HashScan root; same as scripts/lib/chainAdapters.js (Hedera ignores chain.explorer there too). */
export const HASHSCAN = "https://hashscan.io/mainnet";

/** chains[].vm, defaulting to "evm"; a chain keyed "solana" without vm is Solana. */
export const resolveChainVm = (chain: Pick<ExplorerChain, "key" | "vm"> | null | undefined): ChainVm => {
  if (chain?.vm === "hedera") return "hedera";
  return chain?.vm === "solana" || (chain?.vm === undefined && chain?.key === "solana") ? "solana" : "evm";
};

/** Case-sensitive / non-hex ids (base58, 0.0.N) must be kept exactly, never lowercased. */
const keepsIdCase = (vm: ChainVm): boolean => vm !== "evm";

const trimRoot = (s: string | undefined) => (s ?? "").replace(/\/+$/, "");

/** The chain's link templates (defaults for its vm, overridden by explorerTemplates). */
export const explorerTemplates = (chain: ExplorerChain): Record<ExplorerKind, string> => {
  const vm = resolveChainVm(chain);
  const root = vm === "hedera" ? HASHSCAN : trimRoot(chain.explorer) || (vm === "solana" ? SOLSCAN : "");
  const defaults: Record<ExplorerKind, string> =
    vm === "solana"
      ? { token: `${root}/token/{address}`, address: `${root}/account/{address}`, tx: `${root}/tx/{tx}` }
      : vm === "hedera"
        ? { token: `${root}/token/{address}`, address: `${root}/account/{address}`, tx: `${root}/transaction/{tx}` }
        : { token: `${root}/token/{address}`, address: `${root}/address/{address}`, tx: `${root}/tx/{tx}` };
  return { ...defaults, ...(chain.explorerTemplates ?? {}) } as Record<ExplorerKind, string>;
};

/** Hex lowercased; base58 (Solana) and Hedera ids kept exactly. */
export const normalizeAddressForChain = (chain: Pick<ExplorerChain, "key" | "vm">, address: string): string =>
  keepsIdCase(resolveChainVm(chain)) ? address.trim() : address.trim().toLowerCase();

/**
 * Link for a token / address / tx on this chain. `lowercase` (EVM only) keeps
 * the historical lowercased token links byte-identical.
 */
export const chainExplorerLink = (
  chain: ExplorerChain,
  kind: ExplorerKind,
  id: string,
  { lowercase = false }: { lowercase?: boolean } = {},
): string => {
  const value = keepsIdCase(resolveChainVm(chain)) ? id.trim() : lowercase ? id.trim().toLowerCase() : id;
  const t = explorerTemplates(chain)[kind];
  return t.split(kind === "tx" ? "{tx}" : "{address}").join(value);
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEDERA_ID = /^\d+\.\d+\.\d+$/;

/**
 * The chain an address belongs to, for rows that carry no chain of their own
 * (supply-reconciliation items). `preferredKey` (e.g. a staking contract's
 * configured chain) wins; otherwise the address shape picks the vm (0x hex =
 * EVM, 0.0.N = Hedera, anything else = Solana) and, among that vm's chains,
 * the origin chain, else the first.
 */
export const chainForAddress = <C extends ExplorerChain & { origin?: boolean }>(
  chains: readonly C[],
  address: string,
  preferredKey?: string,
): C | undefined => {
  const preferred = preferredKey ? chains.find((c) => c.key === preferredKey) : undefined;
  if (preferred) return preferred;
  const a = address.trim();
  const vm: ChainVm = HEDERA_ID.test(a) ? "hedera" : EVM_ADDRESS.test(a) ? "evm" : "solana";
  const ofVm = chains.filter((c) => resolveChainVm(c) === vm);
  const pool = ofVm.length ? ofVm : chains;
  return pool.find((c) => c.origin) ?? pool[0];
};

/** Explorer root for display (Solana: Solscan unless configured; Hedera: HashScan). */
export const explorerRoot = (chain: ExplorerChain): string => {
  const vm = resolveChainVm(chain);
  if (vm === "hedera") return HASHSCAN;
  return trimRoot(chain.explorer) || (vm === "solana" ? SOLSCAN : "");
};
