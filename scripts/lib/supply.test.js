import { describe, expect, it, vi } from "vitest";
import { computeSupplyTotals, EXPECTED_MAX_SUPPLY } from "./supply.js";

const CHAINS = {
  ethereum: { key: "ethereum", origin: true },
  polygon: { key: "polygon" },
  base: { key: "base" },
};

const BRIDGE = "0xbbbb000000000000000000000000000000000000";
const silent = { warn: vi.fn(), log: vi.fn() };

// Shape mirrors real tel-holders.json wallets. The bridge address holds the TEL
// that backs the mirrored balances on polygon/base.
const wallets = ({ bridge = 38_000_000_000, polygon = 40_000_000_000, base = 2_000_000_000 } = {}) => [
  { address: BRIDGE, ethereum_balance: bridge, polygon_balance: 0, base_balance: 0 },
  { address: "0xaaaa000000000000000000000000000000000000", ethereum_balance: 100_000_000_000 - bridge, polygon_balance: 0, base_balance: 0 },
  { address: "0xcccc000000000000000000000000000000000000", ethereum_balance: 0, polygon_balance: polygon, base_balance: base },
];

describe("computeSupplyTotals", () => {
  it("takes supply from the origin chain instead of summing chains", () => {
    // The bug this guards: summing ethereum+polygon+base double-counts every
    // bridged token, which reported ~142B against a 100B max supply and put a
    // 37B bridge contract at the top of the holder list.
    const totals = computeSupplyTotals({ wallets: wallets() }, CHAINS, new Set([BRIDGE]), silent);
    expect(totals.totalSupply).toBe(100_000_000_000);
    expect(totals.originChain).toBe("ethereum");

    const naiveSum = wallets().reduce(
      (acc, w) => acc + w.ethereum_balance + w.polygon_balance + w.base_balance,
      0
    );
    expect(naiveSum).toBe(142_000_000_000);
    expect(totals.totalSupply).toBeLessThan(naiveSum);
  });

  it("produces a per-chain breakdown whose parts sum to the total", () => {
    const totals = computeSupplyTotals({ wallets: wallets() }, CHAINS, new Set([BRIDGE]), silent);
    const sum = Object.values(totals.byChain).reduce((a, b) => a + b, 0);
    expect(sum).toBe(totals.totalSupply);
    // Origin's displayed share excludes what it holds backing the mirrors.
    expect(totals.byChain.ethereum).toBe(100_000_000_000 - 42_000_000_000);
    expect(totals.byChain.polygon).toBe(40_000_000_000);
    expect(totals.byChain.base).toBe(2_000_000_000);
  });

  it("reports mirrored supply not backed by a labelled bridge-lock address", () => {
    // Real data currently shows a ~3.6B shortfall. It must surface, not vanish:
    // that residual is why bridge subtraction is not a safe way to derive supply.
    const logger = { warn: vi.fn(), log: vi.fn() };
    const totals = computeSupplyTotals({ wallets: wallets({ bridge: 38_000_000_000 }) }, CHAINS, new Set([BRIDGE]), logger);
    expect(totals.bridgeLocked).toBe(38_000_000_000);
    expect(totals.mirrorResidual).toBe(4_000_000_000);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("does not warn when bridge locks fully back the mirrored supply", () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const totals = computeSupplyTotals(
      { wallets: wallets({ bridge: 42_000_000_000 }) },
      CHAINS,
      new Set([BRIDGE]),
      logger
    );
    expect(totals.mirrorResidual).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("refuses to publish a supply far from the expected max", () => {
    // Guards the original failure: a wrong denominator shipping silently and
    // making every "% of supply" figure on the site too large.
    const short = [{ address: "0x1", ethereum_balance: 50_000_000_000, polygon_balance: 0, base_balance: 0 }];
    expect(() => computeSupplyTotals({ wallets: short }, CHAINS, new Set(), silent)).toThrow(
      /Refusing to publish a wrong denominator/
    );
    // The previously-hardcoded 92_577_234_366 is >2% below max supply, so the
    // assertion would have caught it had it been derived rather than pinned.
    expect(Math.abs(92_577_234_366 - EXPECTED_MAX_SUPPLY) / EXPECTED_MAX_SUPPLY).toBeGreaterThan(0.02);
  });

  it("fails loudly when no origin chain is configured", () => {
    const noOrigin = { ethereum: { key: "ethereum" }, polygon: { key: "polygon" } };
    expect(() => computeSupplyTotals({ wallets: wallets() }, noOrigin, new Set(), silent)).toThrow(
      /No origin chain configured/
    );
  });

  it("matches the shipped snapshot's own chain sums", () => {
    // Ties the unit test to reality: the same arithmetic against real balances
    // must land within tolerance of the declared max supply.
    const totals = computeSupplyTotals({ wallets: wallets() }, CHAINS, new Set([BRIDGE]), silent);
    expect(Math.abs(totals.totalSupply - EXPECTED_MAX_SUPPLY) / EXPECTED_MAX_SUPPLY).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// TEL v3 (legacy 2-decimal TEL + 18-decimal v3). Magnitudes are the real
// on-chain figures read 2026-10-18 (docs/TEL-CONTRACTS.md "Supply accounting"),
// rounded to whole TEL.
// ---------------------------------------------------------------------------
describe("computeSupplyTotals with TEL v3", () => {
  const LEGACY = { ethereum: 100_000_000_000, polygon: 38_889_754_532, base: 888_555_593 };
  const V3 = { ethereum: 3_554_752_440, polygon: 19_272_342_381, base: 183_046_551 };
  // Swapped legacy sitting in TokenMigration (v3 minted 1:1 against it) ...
  const RETIRED = { ethereum: 3_777_258_945, polygon: 19_109_828_677, base: 123_053_751 };
  // ... plus legacy sent in without a swap (a Polygon transfer with no v3 mint).
  const STRANDED = { ethereum: 0, polygon: 224_744, base: 0 };
  const TM = "0x2703e00cae30a7707e4d18c38f8cb6a4a40c2703";
  const POLY_BRIDGE = "0xbbbb000000000000000000000000000000000001";
  const BASE_BRIDGE = "0xbbbb000000000000000000000000000000000002";
  const locks = new Set([POLY_BRIDGE, BASE_BRIDGE]);
  // v3 conserved: Σ v3 supply == Σ retired legacy (v3 only enters via a swap;
  // bridging burns and re-mints). Make the fixture exactly conserve it.
  const retiredSum = Object.values(RETIRED).reduce((a, b) => a + b, 0);
  const v3Sum = Object.values(V3).reduce((a, b) => a + b, 0);
  const V3_CONSERVED = { ...V3, base: V3.base + (retiredSum - v3Sum) };

  const tokenTotals = Object.fromEntries(
    Object.keys(LEGACY).map((c) => [
      c,
      { legacy: LEGACY[c], v3: V3_CONSERVED[c], retiredLegacy: RETIRED[c], strandedInUpgrade: STRANDED[c] },
    ]),
  );

  // Wallets as the pipeline publishes them: `*_balance` = legacy − retired + v3.
  const buildWallets = ({ netRetired = true } = {}) => {
    const w = [];
    w.push({ address: POLY_BRIDGE, ethereum_balance: LEGACY.polygon, polygon_balance: 0, base_balance: 0 });
    w.push({ address: BASE_BRIDGE, ethereum_balance: LEGACY.base, polygon_balance: 0, base_balance: 0 });
    // The upgrade contract's own wallet: legacy held minus what was swapped.
    w.push({
      address: TM,
      ethereum_balance: netRetired ? STRANDED.ethereum : RETIRED.ethereum + STRANDED.ethereum,
      polygon_balance: netRetired ? STRANDED.polygon : RETIRED.polygon + STRANDED.polygon,
      base_balance: netRetired ? STRANDED.base : RETIRED.base + STRANDED.base,
    });
    // Everyone else, one aggregate wallet per chain, holding the remainder of
    // each chain's legacy + v3 so the chain totals equal the on-chain supplies.
    const others = (c) =>
      LEGACY[c] - RETIRED[c] - STRANDED[c] + V3_CONSERVED[c] - (c === "ethereum" ? LEGACY.polygon + LEGACY.base : 0);
    w.push({
      address: "0xaaaa000000000000000000000000000000000001",
      ethereum_balance: others("ethereum"),
      polygon_balance: others("polygon"),
      base_balance: others("base"),
      ethereum_v3: V3_CONSERVED.ethereum,
    });
    return w;
  };

  it("reconciles legacy + v3 to exactly the 100B total", () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const t = computeSupplyTotals({ wallets: buildWallets() }, CHAINS, locks, logger, tokenTotals);

    expect(t.totalSupply).toBe(100_000_000_000);
    // Parts sum to the total by construction ...
    expect(Object.values(t.byChain).reduce((a, b) => a + b, 0)).toBeCloseTo(100_000_000_000, 3);
    // ... and, independently, the three chains' combined balances (legacy + v3),
    // less the Ethereum locks backing the legacy mirrors, land on 100B too.
    expect(t.crossCheckTotal).toBeCloseTo(100_000_000_000, 0);
    expect(t.mirrorResidual).toBeCloseTo(0, 0);
    expect(t.v3Residual).toBeCloseTo(0, 0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("would overshoot 100B by exactly the swapped amount if the upgrade contract were not netted", () => {
    // This is the bug being fixed: swapped TEL counted both as legacy sitting in
    // the upgrade contract and as the v3 minted against it.
    const t = computeSupplyTotals({ wallets: buildWallets({ netRetired: false }) }, CHAINS, locks, silent, tokenTotals);
    expect(t.crossCheckTotal - 100_000_000_000).toBeCloseTo(retiredSum, 0);
    expect(t.crossCheckTotal).toBeGreaterThan(123_000_000_000);
  });

  it("exposes the per-token ledger for the reconciliation file", () => {
    const t = computeSupplyTotals({ wallets: buildWallets() }, CHAINS, locks, silent, tokenTotals);
    expect(t.tokens.legacy.ethereum).toBe(100_000_000_000);
    expect(t.tokens.retiredLegacy.polygon).toBe(RETIRED.polygon);
    expect(t.tokens.strandedInUpgrade.polygon).toBe(224_744);
    expect(t.bridgeLocked).toBe(LEGACY.polygon + LEGACY.base);
  });

  it("warns when v3 supply no longer matches the legacy retired for it", () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const broken = {
      ...tokenTotals,
      polygon: { ...tokenTotals.polygon, v3: tokenTotals.polygon.v3 + 5_000_000_000 },
    };
    const t = computeSupplyTotals({ wallets: buildWallets() }, CHAINS, locks, logger, broken);
    expect(t.v3Residual).toBeCloseTo(5_000_000_000, 0);
    expect(logger.warn.mock.calls.some(([m]) => /v3 supply/.test(m))).toBe(true);
  });

  it("does not count v3 sitting on a bridge-lock address as bridge backing", () => {
    const wallets = buildWallets();
    wallets[0] = { ...wallets[0], ethereum_balance: wallets[0].ethereum_balance + 1_000, ethereum_v3: 1_000 };
    const t = computeSupplyTotals({ wallets }, CHAINS, locks, silent, tokenTotals);
    expect(t.bridgeLocked).toBe(LEGACY.polygon + LEGACY.base);
  });

  it("is unchanged for legacy-only data (no tokenTotals): pre-v3 snapshots stay valid", () => {
    const a = computeSupplyTotals({ wallets: wallets() }, CHAINS, new Set([BRIDGE]), silent);
    const b = computeSupplyTotals({ wallets: wallets() }, CHAINS, new Set([BRIDGE]), silent, null);
    expect(a).toEqual(b);
    expect(a.v3Residual).toBe(0);
    expect(a.tokens.v3).toEqual({ ethereum: 0, polygon: 0, base: 0 });
    expect(a.mirrorResidual).toBe(4_000_000_000);
  });
});
