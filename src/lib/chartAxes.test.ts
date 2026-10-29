import { describe, expect, it } from "vitest";
import { assignAxes, hasRightAxis, keysOnAxis } from "./chartAxes";

describe("assignAxes", () => {
  it("puts everything on the left by default", () => {
    expect(assignAxes([{ key: "a" }, { key: "b" }])).toEqual({ a: "left", b: "left" });
    expect(hasRightAxis([{ key: "a" }, { key: "b" }])).toBe(false);
  });

  it("honours an explicit right axis", () => {
    const s = [{ key: "retail" }, { key: "cex", axis: "right" as const }];
    expect(assignAxes(s)).toEqual({ retail: "left", cex: "right" });
    expect(keysOnAxis(s, "right")).toEqual(["cex"]);
    expect(hasRightAxis(s)).toBe(true);
  });

  it("never lets different units share an axis", () => {
    const s = [
      { key: "holders", unit: "wallets" },
      { key: "balance", unit: "TEL" },
      { key: "more", unit: "wallets" },
    ];
    expect(assignAxes(s)).toEqual({ holders: "left", balance: "right", more: "left" });
  });

  it("does not create a lone right axis when every series asks for it", () => {
    expect(hasRightAxis([{ key: "x", axis: "right" }])).toBe(false);
  });
});

import {
  barSizing,
  computeYAxis,
  computeYAxisFromRows,
  distinctTickFormatter,
  MAX_BAR_PX,
  niceStep,
  niceTicks,
} from "./chartAxes";
import { formatCompact } from "./format";

describe("niceTicks", () => {
  it("covers the range with round steps", () => {
    expect(niceTicks(0, 97)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0, 1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it("has no float noise", () => {
    expect(niceTicks(0, 0.3)).toEqual([0, 0.1, 0.2, 0.3]);
      });
  it("niceStep rounds up to 1/2/2.5/5", () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(4.1)).toBe(5);
    expect(niceStep(0)).toBe(1);
  });
});

describe("computeYAxis", () => {
  it("empty data gets a harmless 0..1 axis", () => {
    const y = computeYAxis([], { kind: "line" });
    expect(y.domain).toEqual([0, 1]);
    expect(y.baseline).toBeNull();
    expect(computeYAxis([null, undefined, NaN], { kind: "bar" }).domain).toEqual([0, 1]);
  });

  it("flat line: pads around the level, flags the non-zero baseline", () => {
    const y = computeYAxis([1000, 1000, 1000], { kind: "line" });
    expect(y.domain[0]).toBeGreaterThan(0);
    expect(y.domain[0]).toBeLessThan(1000);
    expect(y.domain[1]).toBeGreaterThan(1000);
    expect(y.baseline).toBe(y.domain[0]);
  });

  it("single point behaves like a flat line", () => {
    const y = computeYAxis([42], { kind: "line" });
    expect(y.domain[0]).toBeLessThan(42);
    expect(y.domain[1]).toBeGreaterThan(42);
  });

  it("near-flat line zooms in instead of starting at zero", () => {
    const y = computeYAxis([17.41e9, 17.43e9, 17.44e9], { kind: "line" });
    expect(y.domain[0]).toBeGreaterThan(17e9);
    expect(y.domain[1]).toBeLessThan(18e9);
    expect(y.baseline).not.toBeNull();
    expect(y.ticks[0]).toBe(y.domain[0]);
    expect(y.ticks[y.ticks.length - 1]).toBe(y.domain[1]);
  });

  it("a line with a big swing keeps the zero baseline and no flag", () => {
    const y = computeYAxis([10, 400, 1000], { kind: "line" });
    expect(y.domain[0]).toBe(0);
    expect(y.domain[1]).toBeGreaterThanOrEqual(1000);
    expect(y.baseline).toBeNull();
  });

  it("huge range stays finite with sensible ticks", () => {
    const y = computeYAxis([1, 5e12], { kind: "line" });
    expect(y.domain[0]).toBe(0);
    expect(y.domain[1]).toBeGreaterThanOrEqual(5e12);
    expect(y.ticks.length).toBeLessThanOrEqual(12);
  });

  it("negative / signed lines include zero and both sides", () => {
    const y = computeYAxis([-30, 10, 50], { kind: "line" });
    expect(y.domain[0]).toBeLessThanOrEqual(-30);
    expect(y.domain[1]).toBeGreaterThanOrEqual(50);
    expect(y.ticks).toContain(0);
    expect(y.baseline).toBeNull();
  });

  it("all-negative near-flat line pads instead of anchoring at zero", () => {
    const y = computeYAxis([-100, -102, -101], { kind: "line" });
    expect(y.domain[1]).toBeLessThan(0);
  });

  it("clamps at zero when negatives are not allowed", () => {
    expect(computeYAxis([1, 2, 3], { kind: "line", allowNegative: false }).domain[0]).toBe(0);
  });

  it("bars: zero baseline, max with headroom", () => {
    const y = computeYAxis([3, 40, 97], { kind: "bar" });
    expect(y.domain[0]).toBe(0);
    expect(y.domain[1]).toBeGreaterThan(97);
    expect(y.domain[1]).toBeLessThanOrEqual(125);
    expect(y.baseline).toBeNull();
  });

  it("bars: all equal values are not stretched to the ceiling", () => {
    const y = computeYAxis([50, 50, 50], { kind: "bar" });
    expect(y.domain[0]).toBe(0);
    expect(y.domain[1]).toBeGreaterThan(50);
    expect(y.domain[1]).toBeLessThan(70);
  });

  it("bars: negatives get a tight negative side, not a mirror", () => {
    const y = computeYAxis([-5, 80, 20], { kind: "bar" });
    expect(y.domain[0]).toBeLessThan(0);
    expect(y.domain[0]).toBeGreaterThanOrEqual(-20);
    expect(y.domain[1]).toBeGreaterThanOrEqual(80);
  });

  it("bars: all zero or all negative stay valid", () => {
    expect(computeYAxis([0, 0], { kind: "bar" }).domain).toEqual([0, 1]);
    const y = computeYAxis([-10, -4], { kind: "bar" });
    expect(y.domain[1]).toBe(0);
    expect(y.domain[0]).toBeLessThan(-10);
  });
});

describe("computeYAxisFromRows (visible rows / series only)", () => {
  const rows = [
    { a: 100, b: 1_000_000 },
    { a: 110, b: 2_000_000 },
    { a: 105, b: null },
  ];
  it("ignores hidden series: a huge hidden series does not flatten the visible one", () => {
    const visibleOnly = computeYAxisFromRows(rows, ["a"], { kind: "line" });
    const both = computeYAxisFromRows(rows, ["a", "b"], { kind: "line" });
    expect(visibleOnly.domain[1]).toBeLessThan(200);
    expect(both.domain[1]).toBeGreaterThan(2_000_000);
  });
  it("reflects only the zoom window rows", () => {
    const all = computeYAxisFromRows([{ a: 1 }, { a: 1000 }], ["a"], { kind: "bar" });
    const zoomed = computeYAxisFromRows([{ a: 1 }], ["a"], { kind: "bar" });
    expect(zoomed.domain[1]).toBeLessThan(all.domain[1]);
  });
  it("no visible series yields the empty axis", () => {
    expect(computeYAxisFromRows(rows, [], { kind: "line" }).domain).toEqual([0, 1]);
  });
});

describe("distinctTickFormatter", () => {
  it("adds precision until tight ticks read differently", () => {
    const y = computeYAxis([17.41e9, 17.43e9, 17.44e9], { kind: "line" });
    const f = distinctTickFormatter(y.ticks, formatCompact);
    const labels = y.ticks.map(f);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("barSizing", () => {
  it("caps width, enforces a minimum bar height, loosens the gap for few bars", () => {
    const few = barSizing(2);
    expect(few.maxBarSize).toBe(MAX_BAR_PX);
    expect(few.minPointSize(5)).toBeGreaterThan(0);
    expect(few.minPointSize(0)).toBe(0);
    expect(few.minPointSize(null)).toBe(0);
    expect(barSizing(2).barCategoryGap).not.toBe(barSizing(40).barCategoryGap);
  });
});

describe("integer axes", () => {
  it("never puts a gridline between whole numbers", () => {
    const y = computeYAxis([12, 13], { kind: "line", integer: true });
    expect(y.ticks.every((t) => Number.isInteger(t))).toBe(true);
  });
});

describe("distinctTickFormatter trimming", () => {
  it("drops trailing zeros when the labels stay distinct", () => {
    const f = distinctTickFormatter([0, 200e6, 400e6], formatCompact);
    expect(f(200e6)).toBe("200M");
    expect(f(0)).toBe("0");
    expect(f(1.5e9)).toBe("1.5B");
    expect(f(-400e6)).toBe("-400M");
  });
});
