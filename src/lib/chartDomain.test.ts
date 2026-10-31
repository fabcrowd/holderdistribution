import { describe, expect, it } from "vitest";
import { maskExcludedSegments } from "@/lib/chartDomain";

type Row = { t: number; a: number | null; b: number | null };

// Oldest t 0..99 (long, always kept), island t 100..104 (short, excluded),
// newest t 105..124 (flat). Breaks at 100 and 105.
const islandRows = (): Row[] => {
  const rows: Row[] = [];
  for (let t = 0; t < 100; t += 1) rows.push({ t, a: 100, b: 200 });
  for (let t = 100; t < 105; t += 1) rows.push({ t, a: 50, b: 200 });
  for (let t = 105; t < 125; t += 1) rows.push({ t, a: 200, b: 200 });
  return rows;
};
const BREAKS = [100, 105];

describe("maskExcludedSegments", () => {
  it("nulls the island between two breaks and keeps the long older and newest segments", () => {
    const masked = maskExcludedSegments(islandRows(), ["a"], BREAKS, "t");
    expect(masked.filter((r) => r.t >= 100 && r.t < 105).every((r) => r.a === null)).toBe(true);
    expect(masked.filter((r) => r.t < 100).every((r) => r.a === 100)).toBe(true);
    expect(masked.filter((r) => r.t >= 105).every((r) => r.a === 200)).toBe(true);
  });

  it("keeps the row and its timestamp for masked points", () => {
    const masked = maskExcludedSegments(islandRows(), ["a"], BREAKS, "t");
    expect(masked).toHaveLength(125);
    expect(masked[101]).toEqual({ t: 101, a: null, b: 200 });
  });

  it("keeps a small step that is within the budget", () => {
    const rows: Row[] = [];
    for (let t = 0; t < 10; t += 1) rows.push({ t, a: 100, b: null });
    rows.push({ t: 10, a: 101, b: null }, { t: 11, a: 101, b: null });
    for (let t = 12; t < 22; t += 1) rows.push({ t, a: 102, b: null });
    const masked = maskExcludedSegments(rows, ["a"], [10, 12], "t");
    expect(masked.map((r) => r.a)).toEqual(rows.map((r) => r.a));
  });

  it("decides each key independently", () => {
    const masked = maskExcludedSegments(islandRows(), ["a", "b"], BREAKS, "t");
    // "b" is flat across the island, so it is kept there; "a" is masked.
    expect(masked.find((r) => r.t === 101)).toEqual({ t: 101, a: null, b: 200 });
  });

  it("returns the same array when there are no breaks", () => {
    const rows = islandRows();
    expect(maskExcludedSegments(rows, ["a"], [], "t")).toBe(rows);
  });

  it("does not mutate the input rows", () => {
    const rows = islandRows();
    const snapshot = JSON.parse(JSON.stringify(rows));
    maskExcludedSegments(rows, ["a"], BREAKS, "t");
    expect(rows).toEqual(snapshot);
  });

  it("gives the same result for unsorted input", () => {
    const rows = islandRows();
    const shuffled = [...rows].reverse();
    const byTime = (xs: Row[]) => [...xs].sort((x, y) => x.t - y.t);
    expect(byTime(maskExcludedSegments(shuffled, ["a"], BREAKS, "t"))).toEqual(
      byTime(maskExcludedSegments(rows, ["a"], BREAKS, "t")),
    );
  });

  it("leaves rows alone when the break is after every row", () => {
    const rows = islandRows();
    expect(maskExcludedSegments(rows, ["a"], [999], "t")).toEqual(rows);
  });
});
