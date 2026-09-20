import { describe, expect, it } from "vitest";
import { TEL_TOTAL_SUPPLY, COINGECKO_CIRCULATING, buildReconciliation } from "./reconcileSupply.js";

describe("buildReconciliation chains[].addresses", () => {
  it("merges exclusions.chains[].addresses into the excluded set", () => {
    const snapshot = {
      wallets: [
        {
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ethereum_balance: 1_000_000,
          polygon_balance: 0,
          base_balance: 0,
        },
        {
          address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ethereum_balance: 2_000_000,
          polygon_balance: 0,
          base_balance: 0,
        },
      ],
    };
    const exclusions = {
      addresses: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      chains: {
        ethereum: { addresses: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] },
      },
      labels: {},
    };

    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.categories.retail ?? 0).toBe(0);
    expect(r.categories["excluded-unlabelled"]).toBe(3_000_000);
  });

  it("does not insert empty-string into the excluded set", () => {
    const snapshot = {
      wallets: [
        {
          address: "0xcccccccccccccccccccccccccccccccccccccccc",
          ethereum_balance: 500_000,
          polygon_balance: 0,
          base_balance: 0,
        },
      ],
    };
    const exclusions = {
      addresses: [null, "", "  "],
      chains: { ethereum: { addresses: [undefined, ""] } },
      labels: {},
    };
    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.categories.retail).toBe(500_000);
  });
});

describe("buildReconciliation circulating + residual", () => {
  const bridge = "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf";
  const escrow = "0xbd02c51150a4ab6ce97b9de2025644594f3e75b8";
  const treasury = "0x2580ccb2be946ad98effa7f4b76148bed319011c";
  const council = "0xdddddddddddddddddddddddddddddddddddddddd";
  const retail = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  const snapshot = {
    wallets: [
      { address: bridge, ethereum_balance: 40_000_000_000, polygon_balance: 0, base_balance: 0 },
      { address: escrow, ethereum_balance: 6_000_000_000, polygon_balance: 0, base_balance: 0 },
      { address: treasury, ethereum_balance: 1_000_000_000, polygon_balance: 0, base_balance: 0 },
      { address: council, ethereum_balance: 500_000_000, polygon_balance: 0, base_balance: 0 },
      // L2 mirrors short of bridge lock by 100M → residual bridge leg
      { address: retail, ethereum_balance: 52_500_000_000, polygon_balance: 39_900_000_000, base_balance: 0 },
    ],
  };
  const exclusions = {
    addresses: [bridge, escrow, treasury, council],
    labels: {
      [bridge]: { category: "bridge-lock", name: "Polygon bridge" },
      [escrow]: { category: "escrow", name: "BitGo" },
      [treasury]: { category: "treasury", name: "Treasury" },
      [council]: { category: "council", name: "Council" },
    },
  };

  it("keeps escrow in circulating and holds out treasury + council", () => {
    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.categories.escrow).toBe(6_000_000_000);
    expect(r.circulating).toBe(r.counted - 1_000_000_000 - 500_000_000);
    expect(r.circulating).toBeGreaterThan(r.counted - 1_000_000_000 - 500_000_000 - 6_000_000_000);
  });

  it("emits residual that closes counted to totalSupply", () => {
    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.counted + r.residual).toBe(TEL_TOTAL_SUPPLY);
    expect(r.residualParts.bridgeInFlight).toBe(r.bridgeLocked - r.mirrored);
    expect(r.residualParts.originDrift).toBe(r.derivedOriginTotal - TEL_TOTAL_SUPPLY);
    // bridgeInFlight - originDrift reconciles residual (within float noise)
    expect(r.residualParts.bridgeInFlight - r.residualParts.originDrift).toBeCloseTo(r.residual, 5);
  });
});

describe("buildReconciliation nonCirculatingOverride", () => {
  const escrow = "0xbd02c51150a4ab6ce97b9de2025644594f3e75b8";
  const treasury = "0x2580ccb2be946ad98effa7f4b76148bed319011c";
  const council = "0xdddddddddddddddddddddddddddddddddddddddd";
  const retail = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  it("excludes a partial override from circulating while leaving the category bucket untouched", () => {
    // Mirrors the real BitGo case: one escrow address, only part of its
    // balance is contractually committed elsewhere.
    const snapshot = {
      wallets: [
        { address: escrow, ethereum_balance: 6_000_000_000, polygon_balance: 0, base_balance: 0 },
        { address: treasury, ethereum_balance: 1_000_000_000, polygon_balance: 0, base_balance: 0 },
        { address: council, ethereum_balance: 500_000_000, polygon_balance: 0, base_balance: 0 },
        { address: retail, ethereum_balance: 10_000_000_000, polygon_balance: 0, base_balance: 0 },
      ],
    };
    const exclusions = {
      addresses: [escrow, treasury, council],
      labels: {
        [escrow]: { category: "escrow", name: "BitGo", nonCirculatingOverride: 2_000_000_000 },
        [treasury]: { category: "treasury", name: "Treasury" },
        [council]: { category: "council", name: "Council" },
      },
    };

    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.categories.escrow).toBe(6_000_000_000);
    expect(r.circulatingExclusions.total).toBe(2_000_000_000);
    expect(r.circulatingExclusions.items).toEqual([
      { address: escrow, name: "BitGo", amount: 2_000_000_000 },
    ]);
    expect(r.circulating).toBe(r.counted - 1_000_000_000 - 500_000_000 - 2_000_000_000);
    expect(r.warnings).toEqual([]);
  });

  it("clamps an override that exceeds the address's actual balance, and warns instead of over-subtracting", () => {
    const snapshot = {
      wallets: [{ address: escrow, ethereum_balance: 1_000_000, polygon_balance: 0, base_balance: 0 }],
    };
    const exclusions = {
      addresses: [escrow],
      labels: { [escrow]: { category: "escrow", name: "BitGo", nonCirculatingOverride: 5_000_000 } },
    };

    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.circulatingExclusions.total).toBe(1_000_000);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(escrow);
  });

  it("warns even when the wallet is fully drained to zero, rather than silently dropping the exclusion", () => {
    const snapshot = {
      wallets: [{ address: escrow, ethereum_balance: 0, polygon_balance: 0, base_balance: 0 }],
    };
    const exclusions = {
      addresses: [escrow],
      labels: { [escrow]: { category: "escrow", name: "BitGo", nonCirculatingOverride: 2_500_000_000 } },
    };

    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.circulatingExclusions.total).toBe(0);
    expect(r.warnings).toHaveLength(1);
  });

  it("sums overrides across multiple addresses", () => {
    const anchorage = "0xaa9ae53fc7a69fde1baaf6aa03796e6ccc764271";
    const snapshot = {
      wallets: [
        { address: escrow, ethereum_balance: 3_834_240_801, polygon_balance: 0, base_balance: 0 },
        { address: anchorage, ethereum_balance: 2_500_001_000, polygon_balance: 0, base_balance: 0 },
      ],
    };
    const exclusions = {
      addresses: [escrow, anchorage],
      labels: {
        [escrow]: { category: "escrow", name: "BitGo", nonCirculatingOverride: 2_500_000_000 },
        [anchorage]: { category: "escrow", name: "Anchorage", nonCirculatingOverride: 2_500_001_000 },
      },
    };

    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.circulatingExclusions.total).toBe(5_000_001_000);
    expect(r.circulatingExclusions.items).toHaveLength(2);
    expect(r.warnings).toEqual([]);
  });

  it("defaults to no exclusion when nonCirculatingOverride is absent (today's behavior)", () => {
    const snapshot = {
      wallets: [{ address: escrow, ethereum_balance: 6_000_000_000, polygon_balance: 0, base_balance: 0 }],
    };
    const exclusions = {
      addresses: [escrow],
      labels: { [escrow]: { category: "escrow", name: "BitGo" } },
    };

    const r = buildReconciliation(snapshot, exclusions, { wallets: [] });
    expect(r.circulatingExclusions.total).toBe(0);
    expect(r.circulatingExclusions.items).toEqual([]);
    expect(r.circulating).toBe(r.counted);
  });
});

describe("buildReconciliation coingeckoCirculating", () => {
  it("emits the exported constant so consumers never need their own copy", () => {
    const r = buildReconciliation({ wallets: [] }, { addresses: [], labels: {} }, { wallets: [] });
    expect(r.coingeckoCirculating).toBe(COINGECKO_CIRCULATING);
  });
});
