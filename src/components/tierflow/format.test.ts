import { describe, expect, it } from "vitest";
import { fmtInt, fmtTel, signed } from "./format";

describe("fmtTel", () => {
  it("promotes values that would round to 1000K to M", () => {
    expect(fmtTel(999_499)).toBe("999K");
    expect(fmtTel(999_500)).toBe("1.0M");
    expect(fmtTel(999_999)).toBe("1.0M");
    expect(fmtTel(-999_999)).toBe("-1.0M");
  });
  it("promotes values that would round to 1000.0M to B", () => {
    expect(fmtTel(999_960_000)).toBe("1.00B");
  });
  it("keeps ordinary values", () => {
    expect(fmtTel(1_500)).toBe("2K");
    expect(fmtTel(2_340_000)).toBe("2.3M");
    expect(fmtTel(12)).toBe("12");
  });
});

describe("signed", () => {
  it("signs non-zero values", () => {
    expect(signed(5, fmtInt)).toBe("+5");
    expect(signed(-5, fmtInt)).toBe("−5");
  });
  it("never prints +0: zero and values that round to zero are neutral 0", () => {
    expect(signed(0, fmtInt)).toBe("0");
    expect(signed(-0, fmtInt)).toBe("0");
    expect(signed(0.2, fmtInt)).toBe("0");
    expect(signed(-0.4, fmtTel)).toBe("0");
  });
});
