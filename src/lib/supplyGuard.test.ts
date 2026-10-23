import { describe, expect, it } from "vitest";
import { reconcileStatus } from "./supplyGuard";

const B = 1_000_000_000;

describe("reconcileStatus", () => {
  it("is ok for an exact partition", () => {
    expect(reconcileStatus(100 * B, 100 * B).kind).toBe("ok");
  });
  it("is ok within 0.5%", () => {
    expect(reconcileStatus(100.49 * B, 100 * B).kind).toBe("ok");
    expect(reconcileStatus(99.51 * B, 100 * B).kind).toBe("ok");
  });
  it("flags drift beyond 0.5% in either direction", () => {
    const over = reconcileStatus(102.87 * B, 100 * B);
    expect(over.kind).toBe("reconciling");
    if (over.kind === "reconciling") expect(over.driftPct).toBeCloseTo(0.0287, 4);
    expect(reconcileStatus(99.4 * B, 100 * B).kind).toBe("reconciling");
  });
  it("treats unusable totals as reconciling rather than ok", () => {
    expect(reconcileStatus(100 * B, 0).kind).toBe("reconciling");
    expect(reconcileStatus(Number.NaN, 100 * B).kind).toBe("reconciling");
  });
});
