import { describe, expect, it } from "vitest";
import { isVenueScannedFlows } from "./venueFlows";

describe("isVenueScannedFlows", () => {
  it("is false for EVM-only and mixed projects", () => {
    expect(isVenueScannedFlows([{ key: "ethereum" }, { key: "base" }])).toBe(false);
    expect(isVenueScannedFlows([{ key: "ethereum", vm: "evm" }, { key: "solana", vm: "solana" }])).toBe(false);
  });
  it("is true when every chain is Solana or Hedera", () => {
    expect(isVenueScannedFlows([{ key: "solana", vm: "solana" }])).toBe(true);
    expect(isVenueScannedFlows([{ key: "solana" }])).toBe(true);
    expect(isVenueScannedFlows([{ key: "hedera", vm: "hedera" }])).toBe(true);
  });
  it("is false with no chains", () => {
    expect(isVenueScannedFlows([])).toBe(false);
    expect(isVenueScannedFlows(undefined)).toBe(false);
  });
});
