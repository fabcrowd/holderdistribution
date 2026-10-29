import { describe, expect, it } from "vitest";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { cardConcentration, cardTrend } from "./cardTrend";

const e = (date: string, holderCount: unknown) => ({ date, combined: { holderCount } }) as never;

describe("cardTrend", () => {
  it("keeps only the last 30 days before the newest entry, sorted", () => {
    const rows = [e("2026-10-29", 30), e("2026-09-01", 1), e("2026-09-29", 10), e("2026-10-15", 20)];
    const t = cardTrend(rows)!;
    expect(t.points.map((p) => p.v)).toEqual([10, 20, 30]);
    expect(t.spanDays).toBe(30);
  });
  it("returns null for missing, empty or single-point history", () => {
    expect(cardTrend(undefined)).toBeNull();
    expect(cardTrend([])).toBeNull();
    expect(cardTrend([e("2026-10-29", 5)])).toBeNull();
    expect(cardTrend([e("2026-10-01", 5), e("2026-10-29", 6)], 7)).toBeNull();
  });
  it("skips rows with bad dates or counts and handles a short series (5 rows)", () => {
    const rows = ["25", "26", "27", "28", "29"].map((d, i) => e(`2026-10-${d}`, 100 + i));
    expect(cardTrend([...rows, e("bad", 1), e("2026-10-30", NaN)])!.points).toHaveLength(5);
  });
});

describe("cardConcentration", () => {
  const snap = (top: unknown, base: unknown) =>
    ({ views: { combined: { metrics: { retail: { balance: base } }, concentration: { top } } } }) as unknown as HolderLiteSnapshot;
  it("divides top-N balance by retail balance", () => {
    expect(cardConcentration(snap({ 10: 25, 100: 50 }, 100))).toEqual({ top10: "25.0%", top100: "50.0%" });
  });
  it("dashes what is missing", () => {
    expect(cardConcentration(snap({ 10: 25 }, 100))).toEqual({ top10: "25.0%", top100: "—" });
    expect(cardConcentration(snap({ 10: 25 }, 0)).top10).toBe("—");
    expect(cardConcentration(null)).toEqual({ top10: "—", top100: "—" });
  });
});
