import { describe, expect, it } from "vitest";
import { hederaChecksum, parseHederaAddress } from "./address.js";
import { canonicalAddressForVm, isAddressForVm, normalizeAddressForVm } from "../address.js";
import { walletsForChain } from "../ledger/config.js";
import { hederaAdapter } from "./adapter.js";

describe("hedera addresses", () => {
  it("accepts the canonical 0.0.N form, trimmed", () => {
    expect(parseHederaAddress("0.0.98")).toBe("0.0.98");
    expect(parseHederaAddress("  0.0.1456985 ")).toBe("0.0.1456985");
  });

  it("accepts the checksum form only when the mainnet checksum is right", () => {
    expect(hederaChecksum("0.0.123")).toBe("vfmkw");
    expect(parseHederaAddress("0.0.123-vfmkw")).toBe("0.0.123");
    expect(parseHederaAddress("0.0.123-aaaaa")).toBeNull();
    expect(parseHederaAddress("0.0.123-VFMKW")).toBeNull();
    expect(parseHederaAddress("0.0.124-vfmkw")).toBeNull();
  });

  it("accepts the long-zero EVM form, rejects aliases and the zero address", () => {
    expect(parseHederaAddress("0x000000000000000000000000000000000000007b")).toBe("0.0.123");
    expect(parseHederaAddress("0x00000000000000000000000000000000000000FF")).toBe("0.0.255");
    expect(parseHederaAddress("0x824cc7addb1a31cb7aa25722aef5f1594b30c688")).toBeNull();
    expect(parseHederaAddress("0x0000000000000000000000000000000000000000")).toBeNull();
    expect(parseHederaAddress("0x0000000000000001000000000000000000000001")).toBeNull();
  });

  it("rejects everything else", () => {
    const bad = ["1.0.5", "0.1.5", "0.0.0", "0.0.007", "0.0.", "0.0.1.2", "abc", "", "0.0.-5", "0.0.9223372036854775808", null, undefined, 5];
    for (const value of bad) expect(parseHederaAddress(value)).toBeNull();
    expect(parseHederaAddress("0.0.9223372036854775807")).toBe("0.0.9223372036854775807");
  });

  it("the shared vm table folds every spelling through the same code", () => {
    expect(isAddressForVm("hedera", "0.0.5")).toBe(true);
    expect(isAddressForVm("hedera", "0.0.05")).toBe(false);
    expect(normalizeAddressForVm("hedera", " 0.0.5 ")).toBe("0.0.5");
    expect(normalizeAddressForVm("hedera", "0.0.123-vfmkw")).toBe("0.0.123");
    expect(normalizeAddressForVm("hedera", "0x000000000000000000000000000000000000007b")).toBe("0.0.123");
    expect(normalizeAddressForVm("hedera", "0.0.123-aaaaa")).toBeNull();
    expect(canonicalAddressForVm("hedera", "0.0.123-vfmkw")).toBe("0.0.123");
    for (const form of ["0.0.123", "0.0.123-vfmkw", "0x000000000000000000000000000000000000007b"]) {
      expect(hederaAdapter.normalizeAddress({}, form)).toBe(normalizeAddressForVm("hedera", form));
    }
  });

  it("ledger developer wallets are supported for hedera (0.0.N ids) and an unknown vm still fails loudly", () => {
    expect(walletsForChain({ developerWallets: [{ address: "0.0.400", label: "t" }, { address: "0x" + "1".repeat(40), label: "e" }] }, "hedera", "hedera")).toEqual([{ address: "0.0.400", label: "t" }]);
    expect(() => walletsForChain({ developerWallets: [] }, "hedera", "cosmos")).toThrow(/cosmos/);
  });
});
