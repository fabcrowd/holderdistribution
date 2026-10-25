/**
 * Program-derived addresses without @solana/web3.js: sha256 from node:crypto
 * and an ed25519 "is this 32-byte string a curve point?" check in BigInt
 * (same acceptance rule as curve25519-dalek's CompressedEdwardsY::decompress,
 * which is what the Solana runtime uses).
 */
import { createHash } from "node:crypto";
import { base58Decode, base58Encode } from "../address.js";

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
const pow = (b, e) => {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
};
const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** True when the 32 bytes decompress to an ed25519 point. */
export function isOnCurve(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = (v * v * v) % P;
  const v7 = (v3 * v3 * v) % P;
  let x = (u * v3 % P) * pow(u * v7, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) {
    x = (x * SQRT_M1) % P;
    return true;
  }
  return u === 0n;
}

const toBytes = (seed) => {
  if (typeof seed === "string") return Buffer.from(seed, "utf8");
  return Buffer.from(seed);
};

/** createProgramAddress: null when the hash lands on the curve. */
export function createProgramAddress(seeds, programId) {
  const program = base58Decode(programId);
  if (!program || program.length !== 32) throw new Error(`bad program id ${programId}`);
  const h = createHash("sha256");
  for (const s of seeds) {
    const b = toBytes(s);
    if (b.length > 32) throw new Error("PDA seed longer than 32 bytes");
    h.update(b);
  }
  h.update(Buffer.from(program));
  h.update(Buffer.from("ProgramDerivedAddress", "utf8"));
  const out = new Uint8Array(h.digest());
  return isOnCurve(out) ? null : base58Encode(out);
}

/** findProgramAddress: [address, bump] for the highest bump that is off-curve. */
export function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const addr = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (addr) return [addr, bump];
  }
  throw new Error("no viable PDA bump");
}

export const METAPLEX_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** Metaplex Token Metadata PDA for a mint. */
export function metaplexMetadataPda(mint) {
  const mintBytes = base58Decode(mint);
  const programBytes = base58Decode(METAPLEX_METADATA_PROGRAM);
  return findProgramAddress([Buffer.from("metadata"), programBytes, mintBytes], METAPLEX_METADATA_PROGRAM)[0];
}
