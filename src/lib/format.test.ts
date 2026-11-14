import { describe, expect, it } from "vitest";
import {
  COMPACT_AXIS,
  COMPACT_CEX_TILE,
  COMPACT_CLAIM,
  COMPACT_FLOW_ROW,
  COMPACT_LEDGER,
  COMPACT_TARGET_LABEL,
  COMPACT_TIERFLOW,
  COMPACT_TOKEN_AMOUNT,
  COMPACT_WALLET_FLOWS,
  describeFreshness,
  formatCompact,
  formatRelativeAge,
  formatSignedCompact,
  formatSourceLabel,
} from "./format";
import { supplyTargetLabel } from "./projects";

const NOW = Date.parse("2026-10-23T12:00:00Z");

// --- Reference implementations: verbatim copies of the private formatters this
// module replaced, kept only so the tests can prove the merge changed no output
// for 0, NaN and every |v| in [1, 1e12). Delete once the owner unifies the sites.
const legacySupplyBreakdownFmt = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};
// TelDispositionLedger and DispositionPnlView carried the identical body.
const legacyLockedTileFmt = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "—";
  return legacySupplyBreakdownFmt(value);
};
const legacyHolderGrowthFmt = (value: number, unit: string, digits = 2) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(digits)}B ${unit}`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(digits)}M ${unit}`;
  return `${new Intl.NumberFormat().format(Math.round(value))} ${unit}`;
};
const legacyTreasuryFmt = (value: number, unit: string, digits = 1) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(Math.max(2, digits))}B ${unit}`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(Math.max(1, digits))}M ${unit}`;
  return `${new Intl.NumberFormat().format(Math.round(value))} ${unit}`;
};
const legacyCexTileFmt = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return `${Math.round(value)}`;
};
const legacyFlowRowFmt = (value: number) => {
  const a = Math.abs(value);
  if (a >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return `${Math.round(value)}`;
};
const legacyWalletFlowsFmt = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};
// DistributionAnalysisWidget, WalletHoldingsWidget and useEcosystemHeadlineTiles.
const legacyTokenAmountFmt = (value: number) => {
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (absolute >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
};
const legacyClaimFmt = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
};
const legacyTierflowFmt = (v: number) => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9 || Number((a / 1e6).toFixed(1)) >= 1000) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6 || Math.round(a / 1e3) >= 1000) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${Math.round(v)}`;
};
const legacySupplyTargetLabel = (t: number) => {
  if (t >= 1e9) return `${+(t / 1e9).toFixed(2)}B`;
  if (t >= 1e6) return `${+(t / 1e6).toFixed(2)}M`;
  return t.toLocaleString("en-US");
};

/** Inputs with |v| in [1, 1e12), plus 0 and NaN, including values at every rounding edge. */
const GRID = [
  0, 1, 1.5, 9.99, 10, 999, 999.5, 1_000, 1_234, 1_950, 99_999, 999_499, 999_500, 999_999, 1e6, 1.5e6, 2.5e8,
  999_949_999, 999_950_000, 999_999_999, 9.99e8, 1e9, 1.234e9, 9.5e10, 1e11, 9.99e11,
  -1, -999, -1_234, -999_999, -2.5e6, -1.5e9, -9.5e10, Number.NaN,
];

describe("one formatter reproduces every legacy site byte-for-byte on [1, 1e12), 0 and NaN", () => {
  const same = (name: string, now: (v: number) => string, legacy: (v: number) => string) =>
    it(name, () => {
      for (const v of GRID) expect(now(v), `${name} @ ${v}`).toBe(legacy(v));
    });

  same("SupplyBreakdown / TelDispositionLedger / DispositionPnlView", (v) => formatCompact(v, COMPACT_LEDGER), legacySupplyBreakdownFmt);
  same("LockedAnalysisTile", (v) => formatCompact(v, { ...COMPACT_LEDGER, nonFinite: "—" }), legacyLockedTileFmt);
  same("CexHistoryTiles", (v) => formatCompact(v, COMPACT_CEX_TILE), legacyCexTileFmt);
  same("DexSwaps / ExchangeNetflow", (v) => formatCompact(v, COMPACT_FLOW_ROW), legacyFlowRowFmt);
  same("WalletFlowsPanel", (v) => formatCompact(v, COMPACT_WALLET_FLOWS), legacyWalletFlowsFmt);
  same("Distribution / WalletHoldings / headline tiles", (v) => formatCompact(v, COMPACT_TOKEN_AMOUNT), legacyTokenAmountFmt);
  same("ledgerClaims", (v) => formatCompact(v, COMPACT_CLAIM), legacyClaimFmt);
  same("tierflow fmtTel", (v) => formatCompact(v, { ...COMPACT_TIERFLOW, nonFinite: "—" }), legacyTierflowFmt);

  it("HolderGrowthWidget (unit + digits)", () => {
    for (const digits of [0, 1, 2, 3]) {
      for (const v of GRID) {
        expect(`${formatCompact(v, { ...COMPACT_AXIS, digits })} TEL`, `${v} @ ${digits}`).toBe(legacyHolderGrowthFmt(v, "TEL", digits));
      }
    }
  });

  it("TreasuryHistoryChart (unit + digits)", () => {
    for (const digits of [0, 1, 2, 3]) {
      for (const v of GRID) {
        const now = `${formatCompact(v, { ...COMPACT_AXIS, digits: Math.max(2, digits), millionDigits: Math.max(1, digits) })} TEL`;
        expect(now, `${v} @ ${digits}`).toBe(legacyTreasuryFmt(v, "TEL", digits));
      }
    }
  });

  it("supplyTargetLabel for targets in [1M, 1e12)", () => {
    for (const t of [1e6, 1.5e6, 2.5e8, 1e9, 1.5e9, 1e10, 7.035e10, 1e11, 9.99e11]) {
      expect(supplyTargetLabel({ supply: { target: t } }), `${t}`).toBe(legacySupplyTargetLabel(t));
    }
  });
});

describe("formatCompact new ranges", () => {
  it("adds a T tier so 1e12+ never prints 1,000.00B", () => {
    expect(formatCompact(1e12)).toBe("1.00T");
    expect(formatCompact(1.5e12)).toBe("1.50T");
    expect(formatCompact(-2.5e12)).toBe("-2.50T");
    expect(formatCompact(1e12, COMPACT_LEDGER)).toBe("1.00T");
    expect(formatCompact(1e12, COMPACT_FLOW_ROW)).toBe("1.00T");
    expect(formatCompact(3.2e12, COMPACT_TIERFLOW)).toBe("3.20T");
    expect(formatCompact(1e12, { ...COMPACT_AXIS, digits: 2 })).toBe("1.00T");
    expect(formatCompact(1e12, COMPACT_TARGET_LABEL)).toBe("1T");
    expect(supplyTargetLabel({ supply: { target: 1e12 } })).toBe("1T");
    expect(supplyTargetLabel({ supply: { target: 1.5e12 } })).toBe("1.5T");
  });

  it("prints significant digits for 0 < |v| < 1 in every family", () => {
    const families = [COMPACT_LEDGER, COMPACT_FLOW_ROW, COMPACT_CEX_TILE, COMPACT_WALLET_FLOWS, COMPACT_TOKEN_AMOUNT, COMPACT_CLAIM, COMPACT_AXIS, COMPACT_TIERFLOW];
    for (const f of families) {
      expect(formatCompact(0.0042, f)).toBe("0.0042");
      expect(formatCompact(0.5, f)).toBe("0.5");
      expect(formatCompact(0.123456, f)).toBe("0.12");
      expect(formatCompact(-0.0042, f)).toBe("-0.0042");
      expect(formatCompact(0.00000042, f)).toBe("0.00000042");
    }
    expect(formatCompact(0.0042)).toBe("0.0042");
    expect(formatCompact(0.9999)).toBe("1");
    expect(formatCompact(0)).toBe("0");
  });

  it("prints 0 for sub-1e-12 dust and never -0", () => {
    expect(formatCompact(1e-15)).toBe("0");
    expect(formatCompact(-1e-15)).toBe("0");
  });

  it("keeps the legacy non-finite text per site", () => {
    expect(formatCompact(null)).toBe("—");
    expect(formatCompact(undefined, COMPACT_LEDGER)).toBe("NaN");
    expect(formatCompact(Number.NaN, { ...COMPACT_TIERFLOW, nonFinite: "—" })).toBe("—");
  });
});

describe("formatCompact", () => {
  it("abbreviates large numbers consistently", () => {
    expect(formatCompact(100_000_000_000)).toBe("100.00B");
    expect(formatCompact(70_350_000_000)).toBe("70.35B");
    expect(formatCompact(195_180_000)).toBe("195.18M");
    expect(formatCompact(12_345)).toBe("12.3K");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(-2_500_000_000)).toBe("-2.50B");
    expect(formatCompact(Number.NaN)).toBe("—");
  });
  it("signs deltas with a real minus", () => {
    expect(formatSignedCompact(1_500_000)).toBe("+1.50M");
    expect(formatSignedCompact(-1_500_000)).toBe("−1.50M");
    expect(formatSignedCompact(0)).toBe("0");
  });
});

describe("formatRelativeAge", () => {
  it("uses days past 24h instead of hundreds of hours", () => {
    expect(formatRelativeAge("2026-10-02T05:20:40Z", NOW)).toBe("21 days ago");
    expect(formatRelativeAge("2026-10-22T12:00:00Z", NOW)).toBe("1 day ago");
    expect(formatRelativeAge("2026-10-23T07:00:00Z", NOW)).toBe("5 hours ago");
    expect(formatRelativeAge("2026-10-23T11:48:00Z", NOW)).toBe("12 min ago");
    expect(formatRelativeAge("2026-10-23T11:59:30Z", NOW)).toBe("just now");
  });
  it("returns null for missing or invalid input", () => {
    expect(formatRelativeAge(null, NOW)).toBeNull();
    expect(formatRelativeAge("nope", NOW)).toBeNull();
  });
});

describe("describeFreshness", () => {
  it("classifies by the daily cadence", () => {
    expect(describeFreshness("2026-10-23T01:00:00Z", NOW).status).toBe("fresh");
    expect(describeFreshness("2026-10-22T01:00:00Z", NOW).status).toBe("fresh");
    expect(describeFreshness("2026-10-20T12:00:00Z", NOW).status).toBe("delayed");
    const stale = describeFreshness("2026-10-02T05:20:40Z", NOW);
    expect(stale.status).toBe("stale");
    expect(stale.ageDays).toBe(21);
    expect(stale.relative).toBe("21 days ago");
    expect(stale.date).toMatch(/2026/);
    expect(describeFreshness(undefined, NOW).status).toBe("unknown");
  });
});

describe("formatSourceLabel", () => {
  it("dedupes provider and upstream and uses friendly names", () => {
    expect(formatSourceLabel(["rpc", "rpc"])).toBe("On-chain RPC");
    expect(formatSourceLabel(["etherscan", "api.etherscan.io", null])).toBe("Etherscan · api.etherscan.io");
    expect(formatSourceLabel(["dune_query", undefined])).toBe("Dune Query");
    expect(formatSourceLabel([null, ""])).toBeNull();
  });
});
