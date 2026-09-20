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
