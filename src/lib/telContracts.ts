/**
 * Canonical TEL contract registry for the UI.
 *
 * Mirrors config/chains.json (the pipeline's source of truth) — the two are
 * kept in lockstep by scripts/lib/telContracts.test.js. Sources and the
 * on-chain verification for every address live in docs/TEL-CONTRACTS.md.
 *
 * TEL has two generations on every chain:
 *  - legacy TEL (2 decimals, a different address per chain) — deprecated, being
 *    retired through the official 1:1 upgrade;
 *  - TEL v3 / "new TEL" (18 decimals, ONE address on every chain via CREATE3) —
 *    the canonical token, and the native gas token of Telcoin Network.
 * The holder pipeline still reconstructs balances from the legacy contracts.
 */
export type TelChainKey = "ethereum" | "polygon" | "base";

/** TEL v3 is deployed at the same address on Ethereum, Polygon and Base. */
export const TEL_V3_ADDRESS = "0x7e13b43065380acdec1c2d138c579cbbbafa0731";

export const TEL_LEGACY_ADDRESS: Record<TelChainKey, string> = {
  ethereum: "0x467bccd9d29f223bce8043b84e8c8b282827790f",
  polygon: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
  base: "0x09be1692ca16e06f536f0038ff11d1da8524adb1",
};

/** Official upgrade / bridge contracts (identical on all three chains). */
export const TEL_UPGRADE_CONTRACTS = {
  tokenMigration: "0x2703e00cae30a7707e4d18c38f8cb6a4a40c2703",
  migrationVault: "0x222213deb441c5a9f71df2942db431978a733333",
  telcoinBridge: "0x6a7e6616653e84eee0c70257ec2e3d79a4476a7e",
  mintBurnWrapper: "0x4a1c2ab0661651ee55c41db1239f292e00c3d149",
} as const;

export const EXPLORER_BASE: Record<TelChainKey, string> = {
  ethereum: "https://etherscan.io",
  polygon: "https://polygonscan.com",
  base: "https://basescan.org",
};

export const legacyTokenUrl = (chain: TelChainKey): string =>
  `${EXPLORER_BASE[chain]}/token/${TEL_LEGACY_ADDRESS[chain]}`;

export const v3TokenUrl = (chain: TelChainKey): string =>
  `${EXPLORER_BASE[chain]}/token/${TEL_V3_ADDRESS}`;

/** Official, Telcoin-maintained upgrade portal (also the canonical address list). */
export const TEL_UPGRADE_PORTAL_URL = "https://tel3.telcoin.network";
