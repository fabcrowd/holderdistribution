import { describe, expect, it } from "vitest";
import {
  addressFormat,
  base58Decode,
  base58Encode,
  isEvmAddress,
  isSolanaAddress,
  normalizeAddressForVm,
  normalizeAnyAddress,
  normalizeValidAddress,
} from "./address.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HEX = "0x467Bccd9d29f223BcE8043b84E8C8B282827790F";

describe("address formats", () => {
  it("round-trips base58 and validates 32-byte Solana keys", () => {
    const bytes = base58Decode(USDC_MINT);
    expect(bytes).toHaveLength(32);
    expect(base58Encode(bytes)).toBe(USDC_MINT);
    expect(isSolanaAddress(USDC_MINT)).toBe(true);
    expect(isSolanaAddress("So1ana")).toBe(false); // too short
    expect(isSolanaAddress("0OIl" + USDC_MINT.slice(4))).toBe(false); // not base58
    expect(isSolanaAddress(HEX)).toBe(false);
  });

  it("classifies EVM vs Solana", () => {
    expect(isEvmAddress(HEX)).toBe(true);
    expect(addressFormat(HEX)).toBe("evm");
    expect(addressFormat(USDC_MINT)).toBe("solana");
    expect(addressFormat("nope")).toBe(null);
  });

  it("lowercases hex but never base58", () => {
    expect(normalizeAnyAddress(` ${HEX} `)).toBe(HEX.toLowerCase());
    expect(normalizeAnyAddress(` ${USDC_MINT} `)).toBe(USDC_MINT);
    expect(normalizeValidAddress(USDC_MINT)).toBe(USDC_MINT);
    expect(normalizeValidAddress(HEX)).toBe(HEX.toLowerCase());
    expect(normalizeValidAddress("not-an-address")).toBe(null);
    expect(normalizeAddressForVm("solana", USDC_MINT)).toBe(USDC_MINT);
    expect(normalizeAddressForVm("evm", HEX)).toBe(HEX.toLowerCase());
  });
});
