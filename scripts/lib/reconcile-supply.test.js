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

describe("buildReconciliation with TEL v3 (legacy + 18-decimal v3)", () => {
  const POLY_BRIDGE = "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf";
  const TM = "0x2703e00cae30a7707e4d18c38f8cb6a4a40c2703";
  const RETAIL = "0xaaaa000000000000000000000000000000000001";
  const CEX = "0xcccc000000000000000000000000000000000002";

  // 100B legacy minted on Ethereum, 40B of it bridged to Polygon (locked in the
  // predicate). Holders then swap 10B of Polygon-legacy for v3: the 10B legacy
  // sits in TokenMigration, 10B v3 exists on Polygon, and 1,000 more legacy was
  // sent to TokenMigration without a swap.
  const makeTokens = ({ v3Polygon = 10e9 } = {}) => ({
    legacy: { ethereum: 100e9, polygon: 40e9, base: 0 },
    v3: { ethereum: 0, polygon: v3Polygon, base: 0 },
    retiredLegacy: { ethereum: 0, polygon: 10e9, base: 0 },
    strandedInUpgrade: { ethereum: 0, polygon: 1_000, base: 0 },
  });
  const snapshot = ({ netted = true, v3Polygon = 10e9 } = {}) => ({
    totals: { totalSupply: 100e9, originChain: "ethereum", tokens: makeTokens({ v3Polygon }) },
    wallets: [
      { address: POLY_BRIDGE, ethereum_balance: 40e9, polygon_balance: 0, base_balance: 0 },
      { address: CEX, ethereum_balance: 20e9, polygon_balance: 0, base_balance: 0 },
      {
        address: RETAIL,
        ethereum_balance: 40e9,
        // Polygon legacy not in the upgrade contract (40B - 10B swapped - 1,000 stranded)
        // plus all the v3.
        polygon_balance: 40e9 - 10e9 - 1_000 + v3Polygon,
        base_balance: 0,
        polygon_v3: v3Polygon,
      },
      {
        address: TM,
        ethereum_balance: 0,
        polygon_balance: netted ? 1_000 : 10e9 + 1_000,
        base_balance: 0,
      },
    ],
  });
  const exclusions = {
    addresses: [POLY_BRIDGE, TM],
    labels: {
      [POLY_BRIDGE]: { category: "bridge-lock", name: "Polygon predicate" },
      [TM]: { category: "escrow", name: "TokenMigration" },
    },
  };
  const cex = { wallets: [{ address: CEX }] };

  it("buckets every TEL once so counted + residual is exactly 100B", () => {
    const r = buildReconciliation(snapshot(), exclusions, cex);
    expect(r.counted + r.residual).toBe(TEL_TOTAL_SUPPLY);
    expect(r.categories.cex).toBe(20e9);
    // 40B retail on Ethereum + (30B − 1,000 legacy + 10B v3) on Polygon.
    expect(r.categories.retail).toBe(40e9 + 40e9 - 1_000);
    expect(r.categories.escrow).toBe(1_000);
    expect(r.counted).toBe(100e9);
    expect(r.residual).toBe(0);
  });

  it("reports the stranded remainder once, on the escrow-labelled contract, never the swapped legacy", () => {
    const r = buildReconciliation(snapshot(), exclusions, cex);
    const item = r.items.find((i) => i.address === TM);
    expect(item).toMatchObject({ category: "escrow", balance: 1_000, counted: true });
    expect(r.upgrade).toMatchObject({ retiredLegacy: 10e9, v3Supply: 10e9, strandedInUpgrade: 1_000 });
    expect(r.upgrade.retiredLegacyByChain.polygon).toBe(10e9);
    expect(r.upgrade.v3SupplyByChain.polygon).toBe(10e9);
  });

  it("residualParts account for the whole residual (residual = inFlight − drift + unbacked)", () => {
    // 5M v3 minted beyond what was retired (e.g. a bridge transfer mid-flight).
    const r = buildReconciliation(snapshot({ v3Polygon: 10e9 + 5e6 }), exclusions, cex);
    const { bridgeInFlight, originDrift, upgradeUnbacked } = r.residualParts;
    expect(upgradeUnbacked).toBe(-5e6);
    expect(r.residual).toBe(-5e6);
    expect(bridgeInFlight - originDrift + upgradeUnbacked).toBeCloseTo(r.residual, 3);
    // Backing check uses LEGACY mirror supply (gross, including what was retired).
    expect(r.mirrored).toBe(40e9);
    expect(r.mirrorResidual).toBe(0);
  });

  it("without netting, swapped TEL is double counted by exactly the retired amount", () => {
    const r = buildReconciliation(snapshot({ netted: false }), exclusions, cex);
    expect(r.counted - 100e9).toBe(10e9);
  });

  it("is unchanged for a pre-v3 snapshot (no totals.tokens)", () => {
    const pre = {
      wallets: [
        { address: POLY_BRIDGE, ethereum_balance: 40e9, polygon_balance: 0, base_balance: 0 },
        { address: RETAIL, ethereum_balance: 60e9, polygon_balance: 40e9, base_balance: 0 },
      ],
    };
    const r = buildReconciliation(pre, exclusions, { wallets: [] });
    expect(r.upgrade).toBeUndefined();
    expect(r.residualParts.upgradeUnbacked).toBe(0);
    expect(r.counted + r.residual).toBe(TEL_TOTAL_SUPPLY);
    expect(r.derivedOriginTotal).toBe(100e9);
    expect(r.mirrored).toBe(40e9);
  });
});
