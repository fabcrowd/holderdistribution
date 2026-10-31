import { describe, expect, it } from "vitest";
import { hasMoreBelow } from "./scrollMore";

describe("hasMoreBelow", () => {
  it("is true while content remains below", () => {
    expect(hasMoreBelow({ scrollTop: 0, clientHeight: 300, scrollHeight: 590 })).toBe(true);
  });
  it("is false at the bottom, with fractional-height slack", () => {
    expect(hasMoreBelow({ scrollTop: 290, clientHeight: 300, scrollHeight: 590 })).toBe(false);
    expect(hasMoreBelow({ scrollTop: 289.5, clientHeight: 300, scrollHeight: 590 })).toBe(false);
  });
  it("is false when nothing overflows", () => {
    expect(hasMoreBelow({ scrollTop: 0, clientHeight: 120, scrollHeight: 120 })).toBe(false);
  });
});
