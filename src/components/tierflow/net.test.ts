import { describe, expect, it } from "vitest";
import { netWalletsOf, netTelOf, totalNetTel, netSlotText, netOf, netDisplay, NET_MISSING } from "./net";
import { fmtInt, fmtTel } from "./format";
import { netCausesFor } from "./netFlow";
import type { Cause } from "./useFlowField";

const cause = (over: Partial<Cause> = {}): Cause => ({
  dex: 0, dexSwap: 0, dexLp: 0, cex: 0, moved: 0, splitTel: 0, splitDestinationSlots: 0, splitEvents: 0, soloMoved: 0,
  total: 0, sold: 0, soldPct: 0, hasData: false,
  boughtDex: 0, boughtDexSwap: 0, boughtDexLp: 0, boughtCex: 0, receivedWallet: 0, inTotal: 0, hasInData: false,
  inflowsBySourceTier: {}, movedByDestTier: {},
  ...over,
});

// Consistent with causeOfCell: totals are the sums of their parts.
const mixed = cause({
  dexSwap: 4, dexLp: 3, dex: 7, cex: 2, moved: 5, total: 14,
  boughtDexSwap: 6, boughtDexLp: 1, boughtDex: 7, boughtCex: 3, receivedWallet: 9, inTotal: 19,
});

describe("net = in minus out", () => {
  it("wallets: 20 in, 25 out is -5", () => {
    expect(netWalletsOf({ addedCount: 20, removedCount: 25 })).toBe(-5);
  });
  it("TEL: total in minus total out", () => {
    expect(netTelOf({ cause: mixed })).toBe(5);
  });
  it("TEL net equals the sum of the per-category nets", () => {
    const sum = netCausesFor(mixed).reduce((s, c) => s + c.net, 0);
    expect(netTelOf({ cause: mixed })).toBe(sum);
  });
  it("is exactly zero with no flows", () => {
    expect(netTelOf({ cause: cause() })).toBe(0);
    expect(netWalletsOf({ addedCount: 0, removedCount: 0 })).toBe(0);
  });
  it("netSlotText signs the net and shows exact zero as a neutral 0", () => {
    const f = (a: number, r: number) => ({ addedCount: a, removedCount: r, cause: cause() });
    expect(netSlotText("wallets", f(1, 1))).toEqual({ text: "0", tone: "neutral" });
    expect(netSlotText("wallets", f(1112, 1))).toEqual({ text: "+1,111", tone: "positive" });
    expect(netSlotText("wallets", f(3, 11))).toEqual({ text: "−8", tone: "negative" });
    expect(netSlotText("tel", { ...f(0, 0), cause: cause({ total: 3e6, inTotal: 1e6 }) })).toEqual({ text: "−2.0M", tone: "negative" });
    expect(netSlotText("tel", f(5, 0))).toEqual({ text: "0", tone: "neutral" });
  });
  it("TEL total sums the per-tier nets", () => {
    const fs = [
      { addedCount: 111, removedCount: 119, cause: mixed },
      { addedCount: 20, removedCount: 25, cause: cause({ total: 10, inTotal: 4 }) },
    ];
    expect(totalNetTel(fs)).toBe(5 - 6);
  });
});

describe("missing feeds", () => {
  const f = { addedCount: 3, removedCount: 1, cause: mixed };
  it("netOf is null when the metric's own feed is missing, a number otherwise", () => {
    expect(netOf("wallets", f, { hasTransitions: false, hasOutflows: true })).toBeNull();
    expect(netOf("tel", f, { hasTransitions: true, hasOutflows: false })).toBeNull();
    expect(netOf("wallets", f, { hasTransitions: true, hasOutflows: false })).toBe(2);
    expect(netOf("tel", f, { hasTransitions: false, hasOutflows: true })).toBe(5);
  });
  it("renders a neutral dash, not 0", () => {
    expect(netDisplay(null, fmtInt)).toEqual({ text: NET_MISSING, tone: "neutral" });
    expect(netSlotText("wallets", f, { hasTransitions: false, hasOutflows: true })).toEqual({ text: "—", tone: "neutral" });
    expect(netSlotText("tel", f, { hasTransitions: true, hasOutflows: false })).toEqual({ text: "—", tone: "neutral" });
  });
  it("a value that rounds to zero is a neutral 0", () => {
    expect(netDisplay(0.3, fmtTel)).toEqual({ text: "0", tone: "neutral" });
    expect(netDisplay(-0, fmtInt)).toEqual({ text: "0", tone: "neutral" });
  });
});
