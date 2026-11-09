/**
 * Address helpers shared by every chain adapter.
 *
 * EVM addresses are hex and case-insensitive, so the pipeline has always
 * lowercased them. Solana addresses are base58 and CASE-SENSITIVE: lowercasing
 * one turns it into a different (usually invalid) key. Every place that used
 * to do `addr.trim().toLowerCase()` on a holder/exclusion address goes through
 * normalizeAnyAddress() instead, which lowercases hex and leaves base58 alone.
 * For TEL (all hex) the result is byte-for-byte what it was before.
 */
import { assertChainVm } from "./chainVms.js";
import { parseHederaAddress } from "./hedera/address.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((c, i) => [c, BigInt(i)]));
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/** Decodes base58 to bytes; null when the string is not base58. */
export function base58Decode(str) {
  if (typeof str !== "string" || str.length === 0 || !BASE58_RE.test(str)) return null;
  let n = 0n;
  for (const ch of str) n = n * 58n + BASE58_MAP.get(ch);
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Encodes bytes as base58. */
export function base58Encode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let n = 0n;
  for (const b of arr) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of arr) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export const isEvmAddress = (value) => typeof value === "string" && EVM_RE.test(value.trim());

/** A Solana public key: base58 that decodes to exactly 32 bytes. Case-sensitive. */
export function isSolanaAddress(value) {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.length < 32 || s.length > 44) return false;
  const bytes = base58Decode(s);
  return !!bytes && bytes.length === 32;
}

/** Address format: "evm", "solana" or null. */
export function addressFormat(value) {
  if (isEvmAddress(value)) return "evm";
  if (isSolanaAddress(value)) return "solana";
  return null;
}

/**
 * Canonical form for set membership / map keys: hex lowercased, base58 kept
 * exactly as written (trimmed). Anything else falls back to the historical
 * trim+lowercase so legacy callers see no change.
 */
export function normalizeAnyAddress(value) {
  if (typeof value !== "string") return "";
  const s = value.trim();
  if (isSolanaAddress(s)) return s;
  return s.toLowerCase();
}

/**
 * Strict normalizer: a valid EVM address (lowercased) or a valid Solana
 * address (as written); null for anything else.
 */
export function normalizeValidAddress(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (EVM_RE.test(s)) return s.toLowerCase();
  if (isSolanaAddress(s)) return s;
  return null;
}

/** Per-vm address rules: validity test and canonical (map-key) form. Add a vm here and in chainVms.js. */
const ADDRESS_RULES = {
  evm: { test: (s) => EVM_RE.test(s), canonical: (s) => s.toLowerCase() },
  solana: { test: (s) => isSolanaAddress(s), canonical: (s) => s },
  // Folds the checksum and long-zero spellings to 0.0.N; the one implementation (pure, no imports) lives in hedera/address.js.
  hedera: { test: (s) => parseHederaAddress(s) !== null, canonical: (s) => parseHederaAddress(s) ?? s },
};

const rulesFor = (vm) => ADDRESS_RULES[assertChainVm(vm)];

/** True when `value` is a valid address for `vm`. Throws for an unknown vm. */
export const isAddressForVm = (vm, value) => {
  const rules = rulesFor(vm);
  return typeof value === "string" && rules.test(value.trim());
};

/** Canonical form of an address for `vm` without validating it (trim, then lowercase for EVM). Throws for an unknown vm. */
export const canonicalAddressForVm = (vm, value) => rulesFor(vm).canonical(String(value).trim());

/** Address normalizer for one VM: "evm" lowercases (and requires hex), "solana" keeps case. Throws for an unknown vm. */
export function normalizeAddressForVm(vm, value) {
  const rules = rulesFor(vm);
  if (typeof value !== "string") return null;
  const s = value.trim();
  return rules.test(s) ? rules.canonical(s) : null;
}
