import { describe, expect, it } from "vitest";
import {
  describeFreshness,
  formatCompact,
  formatRelativeAge,
  formatSignedCompact,
  formatSourceLabel,
} from "./format";

const NOW = Date.parse("2026-10-23T12:00:00Z");

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
