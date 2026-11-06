import { describe, it, expect } from "vitest";
import { tierFingerprint, shouldResetForTiers } from "./tierFingerprint.js";

const A = [
  { label: "10+", min: 10, max: Number.POSITIVE_INFINITY },
  { label: "1-10", min: 1, max: 10 },
];
const B = [
  { label: "50M+", min: 50e6, max: Number.POSITIVE_INFINITY },
  { label: "1-50M", min: 1, max: 50e6 },
];
const day = (...labels) => ({ date: "2026-01-01", tiers: Object.fromEntries(labels.map((l) => [l, {}])) });

describe("tierFingerprint", () => {
  it("is stable and sensitive to labels and bounds", () => {
    expect(tierFingerprint(A)).toBe(tierFingerprint(A.map((t) => ({ ...t }))));
    expect(tierFingerprint(A)).not.toBe(tierFingerprint(B));
    expect(tierFingerprint(A)).not.toBe(tierFingerprint([A[0], { ...A[1], min: 2 }]));
  });
});

describe("shouldResetForTiers", () => {
  it("keeps a store whose fingerprint matches", () => {
    expect(shouldResetForTiers({ tierFingerprint: tierFingerprint(A), days: [day("10+")] }, A).reset).toBe(false);
  });
  it("resets when tiers changed", () => {
    const r = shouldResetForTiers({ tierFingerprint: tierFingerprint(A), days: [day("10+")] }, B);
    expect(r.reset).toBe(true);
    expect(r.reason).toMatch(/fingerprint/);
  });
  it("adopts a legacy store whose labels all match", () => {
    expect(shouldResetForTiers({ days: [day("10+", "1-10")] }, A).reset).toBe(false);
  });
  it("resets a legacy store with foreign labels", () => {
    expect(shouldResetForTiers({ days: [day("10+", "100B+")] }, A).reset).toBe(true);
  });
  it("never resets an empty store", () => {
    expect(shouldResetForTiers({ days: [] }, A).reset).toBe(false);
    expect(shouldResetForTiers({}, A).reset).toBe(false);
  });
});
