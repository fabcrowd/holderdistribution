import { describe, expect, it } from "vitest";
import { reconcileParts } from "./reconcileParts.js";

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

describe("reconcileParts", () => {
  it("makes the parts sum exactly to the total", () => {
    const out = reconcileParts({ "1M-5M": 0.4, "5M-10M": 0.4, "10M-25M": 100 }, 101);
    expect(sum(out)).toBe(101);
  });

  it("does not let sub-0.5 parts vanish", () => {
    // Naive per-part rounding would drop both 0.4s and land on 100, losing
    // real flow and leaving the breakdown short of its own total.
    const out = reconcileParts({ "1M-5M": 0.4, "5M-10M": 0.4, "10M-25M": 100 }, 101);
    expect(sum(out)).toBe(101);
    expect(Object.keys(out).length).toBeGreaterThan(1);
  });

  it("never emits a negative part when rounding overshoots", () => {
    // Ten parts of 10.5 each round up to 110 against a total of 105. Dumping
    // that -5 residual into `untracked` would render as negative unattributed
    // flow in the UI.
    const src = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, 10.5]));
    const out = reconcileParts(src, 105);
    expect(sum(out)).toBe(105);
    for (const v of Object.values(out)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("keeps every part within 1 of its true value", () => {
    const src = { a: 10.5, b: 20.5, c: 30.5, d: 40.5 };
    const out = reconcileParts(src, 102);
    for (const [k, v] of Object.entries(src)) expect(Math.abs(out[k] - v)).toBeLessThanOrEqual(1);
    expect(sum(out)).toBe(102);
  });

  it("preserves genuinely unattributable flow", () => {
    const out = reconcileParts({ "1M-5M": 300, untracked: 700 }, 1000);
    expect(out).toEqual({ "1M-5M": 300, untracked: 700 });
  });

  it("invents no untracked bucket when everything is attributed", () => {
    const out = reconcileParts({ "1M-5M": 600, "5M-10M": 400 }, 1000);
    expect(out).toEqual({ "1M-5M": 600, "5M-10M": 400 });
    expect(out).not.toHaveProperty("untracked");
  });

  it("reports a pre-attribution day as fully untracked, not falsely attributed", () => {
    // Day buckets scanned before this feature existed carry no breakdown. They
    // must read as "we don't know", never as zero-from-every-tier.
    expect(reconcileParts({}, 5000)).toEqual({ untracked: 5000 });
    expect(reconcileParts(undefined, 5000)).toEqual({ untracked: 5000 });
  });

  it("stays empty when there is no flow at all", () => {
    expect(reconcileParts({}, 0)).toEqual({});
  });

  it("reconciles across a spread of realistic magnitudes", () => {
    const src = { "1-250K": 12345.67, "250K-1M": 987654.32, "1M-5M": 4444444.44, untracked: 999.99 };
    const total = Math.round(Object.values(src).reduce((a, b) => a + b, 0));
    const out = reconcileParts(src, total);
    expect(sum(out)).toBe(total);
    for (const v of Object.values(out)) expect(v).toBeGreaterThanOrEqual(0);
  });
});
