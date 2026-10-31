import { describe, expect, it } from "vitest";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { afterBreakNote, cardConcentration, cardTrend, cardTrendState, trendLabel } from "./cardTrend";

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

describe("cardTrend across methodology breaks", () => {
  const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
  // Ten daily rows 10-20..10-29 with counts 20..29.
  const rows = Array.from({ length: 10 }, (_, i) => e(`2026-10-${20 + i}`, 20 + i));

  it("ignores breaks before the window and after the newest entry", () => {
    const before = cardTrend(rows, 30, [day("2026-09-01")])!;
    expect(before.points).toHaveLength(10);
    expect("sinceBreak" in before).toBe(false);
    expect(cardTrend(rows, 30, [day("2026-10-30")])!.points).toHaveLength(10);
  });
  it("ignores a break exactly at the window cutoff", () => {
    const t = cardTrend(rows, 9, [day("2026-10-20")])!;
    expect(t.points).toHaveLength(10);
    expect("sinceBreak" in t).toBe(false);
  });
  it("starts the trend at one break inside the window", () => {
    const t = cardTrend(rows, 30, [day("2026-10-25")])!;
    expect(t.points.map((p) => p.v)).toEqual([25, 26, 27, 28, 29]);
    expect(t.first.v).toBe(25);
    expect(t.spanDays).toBe(4);
    expect(t.sinceBreak).toBe(day("2026-10-25"));
  });
  it("uses the latest of two breaks inside the window", () => {
    const t = cardTrend(rows, 30, [day("2026-10-26"), day("2026-10-22")])!;
    expect(t.points.map((p) => p.v)).toEqual([26, 27, 28, 29]);
    expect(t.sinceBreak).toBe(day("2026-10-26"));
  });
  it("keeps every point when the break sits on the first point", () => {
    const t = cardTrend(rows, 30, [day("2026-10-20")])!;
    expect(t.points).toHaveLength(10);
    expect(t.sinceBreak).toBe(day("2026-10-20"));
  });
  it("returns null when the break leaves a single point", () => {
    expect(cardTrend(rows, 30, [day("2026-10-29")])).toBeNull();
  });
  it("starts at the first row on or after a break that falls between rows", () => {
    const t = cardTrend(rows, 30, [day("2026-10-25") + 12 * 3_600_000])!;
    expect(t.points.map((p) => p.v)).toEqual([26, 27, 28, 29]);
    expect(t.sinceBreak).toBe(day("2026-10-25") + 12 * 3_600_000);
  });
  it("ignores non-finite break values", () => {
    const t = cardTrend(rows, 30, [Number.NaN])!;
    expect(t.points).toHaveLength(10);
    expect("sinceBreak" in t).toBe(false);
  });
});

describe("cardTrendState", () => {
  const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
  const rows = Array.from({ length: 10 }, (_, i) => e(`2026-10-${20 + i}`, 20 + i));

  it("reports no-history when there are no usable rows", () => {
    expect(cardTrendState(undefined)).toEqual({ trend: null, reason: "no-history" });
    expect(cardTrendState([e("bad", 1)])).toEqual({ trend: null, reason: "no-history" });
  });
  it("reports no-history when fewer than two points are in the window and no break applies", () => {
    expect(cardTrendState([e("2026-10-29", 5)])).toEqual({ trend: null, reason: "no-history" });
    expect(cardTrendState([e("2026-10-01", 5), e("2026-10-29", 6)], 7)).toEqual({ trend: null, reason: "no-history" });
  });
  it("reports after-break when a break leaves fewer than two points", () => {
    const s = cardTrendState(rows, 30, [day("2026-10-29")]);
    expect(s.trend).toBeNull();
    expect(s.reason).toBe("after-break");
    expect(s.sinceBreak).toBe(day("2026-10-29"));
  });
  it("reports ok with the trend when two or more points remain", () => {
    const s = cardTrendState(rows, 30, [day("2026-10-25")]);
    expect(s.reason).toBe("ok");
    expect(s.trend?.points).toHaveLength(5);
    expect(s.trend?.sinceBreak).toBe(day("2026-10-25"));
  });
  it("stays no-history when the break is on the only in-window point", () => {
    const s = cardTrendState([e("2026-10-01", 5), e("2026-10-29", 6)], 7, [day("2026-10-29")]);
    expect(s.trend).toBeNull();
    expect(s.reason).toBe("no-history");
  });
  it("cardTrend returns the same trend as cardTrendState", () => {
    expect(cardTrend(rows, 30, [day("2026-10-25")])).toEqual(cardTrendState(rows, 30, [day("2026-10-25")]).trend);
    expect(cardTrend(rows, 30, [day("2026-10-29")])).toBeNull();
  });
});

describe("afterBreakNote", () => {
  it("formats the after-break note with the break date, or a generic phrase without one", () => {
    expect(afterBreakNote(Date.parse("2026-10-03T00:00:00Z"))).toBe("Not enough data since the Oct 3 methodology change.");
    expect(afterBreakNote(undefined)).toBe("Not enough data since the latest methodology change.");
  });
});

describe("trendLabel", () => {
  it("summarises the first and last point for screen readers", () => {
    const t = {
      points: [],
      first: { t: Date.parse("2026-10-20T00:00:00Z"), v: 1234 },
      last: { t: Date.parse("2026-10-29T00:00:00Z"), v: 1500 },
      spanDays: 9,
    };
    expect(trendLabel("TEL", t)).toBe("TEL retail wallets, Oct 20 to Oct 29: 1,234 to 1,500.");
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
