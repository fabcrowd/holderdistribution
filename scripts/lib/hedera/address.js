/**
 * Hedera account ids. The canonical (and only keyed-on) form is `0.0.N`.
 * Two other spellings name the same account unambiguously and are folded to it:
 *   - `0.0.N-xxxxx`  HIP-15 checksum, valid only when it matches the mainnet ledger
 *   - `0x` + 24 zero hex digits + 16 hex digits (the "long-zero" EVM form of shard 0, realm 0)
 * Anything else is rejected, including real EVM aliases (ECDSA key hashes), because
 * those are not derivable from the account number.
 */
const MAX_ENTITY_NUM = 9223372036854775807n; // int64
const CANONICAL_RE = /^0\.0\.([1-9]\d{0,18})$/;
const CHECKSUM_RE = /^(0\.0\.[1-9]\d{0,18})-([a-z]{5})$/;
const LONG_ZERO_RE = /^0x0{24}([0-9a-fA-F]{16})$/;

const P3 = 26 ** 3;
const P5 = 26 ** 5;
const MULTIPLIER = 1_000_003;
const WEIGHT = 31;
const MAINNET_LEDGER_ID = [0];

/** HIP-15 checksum of a canonical `0.0.N` for the mainnet ledger. */
export function hederaChecksum(canonical, ledgerId = MAINNET_LEDGER_ID) {
  let sd0 = 0;
  let sd1 = 0;
  let sd = 0;
  [...canonical].forEach((ch, i) => {
    const d = ch === "." ? 10 : Number(ch);
    sd = (sd * WEIGHT + d) % P3;
    if (i % 2 === 0) sd0 = (sd0 + d) % 11;
    else sd1 = (sd1 + d) % 11;
  });
  let sh = 0;
  for (const b of [...ledgerId, 0, 0, 0, 0, 0, 0]) sh = (WEIGHT * sh + b) % P5;
  let c = ((((canonical.length % 5) * 11 + sd0) * 11 + sd1) * P3 + sd + sh) % P5;
  c = (c * MULTIPLIER) % P5;
  let out = "";
  for (let i = 0; i < 5; i += 1) {
    out = String.fromCharCode(97 + (c % 26)) + out;
    c = Math.floor(c / 26);
  }
  return out;
}

const inRange = (num) => num >= 1n && num <= MAX_ENTITY_NUM;

/** Canonical `0.0.N` for any accepted spelling, or null. */
export function parseHederaAddress(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  const canonical = CANONICAL_RE.exec(s);
  if (canonical) return inRange(BigInt(canonical[1])) ? s : null;
  const withChecksum = CHECKSUM_RE.exec(s);
  if (withChecksum) {
    const [, base, sum] = withChecksum;
    return inRange(BigInt(base.slice(4))) && hederaChecksum(base) === sum ? base : null;
  }
  const longZero = LONG_ZERO_RE.exec(s);
  if (longZero) {
    const num = BigInt(`0x${longZero[1]}`);
    return inRange(num) ? `0.0.${num}` : null;
  }
  return null;
}

/** Numeric account number of a canonical `0.0.N` (safe integer; ids are about 1.1e7). */
export const accountNum = (canonical) => Number(canonical.slice(4));
