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
 * Mirrors scripts/lib/chainAdapters.js chainExplorerUrl().
 */
export type ChainVm = "evm" | "solana";
export type ExplorerKind = "token" | "address" | "tx";
export type ExplorerTemplates = Partial<Record<ExplorerKind, string>>;

export type ExplorerChain = {
  key: string;
  vm?: ChainVm;
  explorer?: string;
  explorerTemplates?: ExplorerTemplates;
};

export const SOLSCAN = "https://solscan.io";

/** chains[].vm, defaulting to "evm"; a chain keyed "solana" without vm is Solana. */
export const resolveChainVm = (chain: Pick<ExplorerChain, "key" | "vm"> | null | undefined): ChainVm =>
  chain?.vm === "solana" || (chain?.vm === undefined && chain?.key === "solana") ? "solana" : "evm";

const trimRoot = (s: string | undefined) => (s ?? "").replace(/\/+$/, "");

/** The chain's link templates (defaults for its vm, overridden by explorerTemplates). */
export const explorerTemplates = (chain: ExplorerChain): Record<ExplorerKind, string> => {
  const vm = resolveChainVm(chain);
  const root = trimRoot(chain.explorer) || (vm === "solana" ? SOLSCAN : "");
  const defaults: Record<ExplorerKind, string> =
    vm === "solana"
      ? { token: `${root}/token/{address}`, address: `${root}/account/{address}`, tx: `${root}/tx/{tx}` }
      : { token: `${root}/token/{address}`, address: `${root}/address/{address}`, tx: `${root}/tx/{tx}` };
  return { ...defaults, ...(chain.explorerTemplates ?? {}) } as Record<ExplorerKind, string>;
};

/** Hex lowercased; base58 (Solana) kept exactly. */
export const normalizeAddressForChain = (chain: Pick<ExplorerChain, "key" | "vm">, address: string): string =>
  resolveChainVm(chain) === "solana" ? address.trim() : address.trim().toLowerCase();

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
  const value = resolveChainVm(chain) === "solana" ? id.trim() : lowercase ? id.trim().toLowerCase() : id;
  const t = explorerTemplates(chain)[kind];
  return t.split(kind === "tx" ? "{tx}" : "{address}").join(value);
};

/** Explorer root for display (Solana: Solscan unless configured). */
export const explorerRoot = (chain: ExplorerChain): string =>
  trimRoot(chain.explorer) || (resolveChainVm(chain) === "solana" ? SOLSCAN : "");
