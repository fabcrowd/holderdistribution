import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClassificationChangelog, ClassificationEvent } from "@/lib/classificationChangelog";
import { computeBreakAwareDomain, computeSeriesDomain } from "@/lib/chartDomain";
import { BREAK_SUMMARY_MAX, breakNotesByRow, breakTooltip, getSeriesBreaks, insertBreakSpacers, limitedHistoryCount, MIN_SMOOTH_POINTS, SERIES_BREAK_NOTE } from "@/lib/seriesBreaks";

const day = (iso: string) => Date.parse(iso);

const event = (over: Partial<ClassificationEvent>): ClassificationEvent => ({
  id: "e",
  date: "2026-10-26",
  type: "other",
  summary: "s",
  affects: { artifacts: [], metrics: ["retail.balance"] },
  backfillStatus: "not-possible",
  ...over,
});

const feed = (...events: ClassificationEvent[]): ClassificationChangelog => ({
  schemaVersion: 1,
  generatedAt: "2026-10-28T00:00:00Z",
  events,
});

describe("getSeriesBreaks", () => {
  const from = day("2026-10-01");

  it("returns a break for a declared metric, with the default note", () => {
    const out = getSeriesBreaks(feed(event({ breaksSeries: { metrics: ["retail.balance"] } })), ["retail.balance"], from);
    expect(out).toEqual([{ t: day("2026-10-26"), label: "Methodology change", description: SERIES_BREAK_NOTE, summary: "s" }]);
  });

  it("uses breaksSeries.at and note when given", () => {
    const out = getSeriesBreaks(
      feed(event({ date: "2026-10-18", breaksSeries: { metrics: ["retail.balance"], at: "2026-10-03", note: "custom" } })),
      ["retail.balance"],
      from,
    );
    expect(out).toEqual([expect.objectContaining({ t: day("2026-10-03"), description: "custom" })]);
  });

  it("ignores events without the field (absent field = no break) and other metrics", () => {
    expect(getSeriesBreaks(feed(event({})), ["retail.balance"], from)).toEqual([]);
    expect(getSeriesBreaks(feed(event({ breaksSeries: { metrics: ["cexBalance"] } })), ["retail.balance"], from)).toEqual([]);
  });

  it("ignores breaks outside the window, backfilled events, and missing feeds", () => {
    const spec = { metrics: ["retail.balance"] };
    expect(getSeriesBreaks(feed(event({ breaksSeries: spec })), ["retail.balance"], day("2026-10-26"))).toEqual([]);
    expect(getSeriesBreaks(feed(event({ breaksSeries: spec, backfillStatus: "complete" })), ["retail.balance"], from)).toEqual([]);
    expect(getSeriesBreaks(null, ["retail.balance"], from)).toEqual([]);
    expect(getSeriesBreaks(feed(event({ breaksSeries: spec })), ["retail.balance"], undefined)).toEqual([]);
  });
});

describe("insertBreakSpacers", () => {
  const rows = [
    { t: day("2026-10-01"), v: 10 as number | null },
    { t: day("2026-10-02"), v: 11 },
    { t: day("2026-10-03"), v: 20 },
    { t: day("2026-10-04"), v: 21 },
  ];

  it("inserts one null spacer between the last old row and the first new row", () => {
    const out = insertBreakSpacers(rows, [day("2026-10-03")], "t", ["v"]);
    expect(out).toHaveLength(5);
    expect(out[2]).toEqual({ t: (day("2026-10-02") + day("2026-10-03")) / 2, v: null });
    expect(out.filter((r) => r.v != null)).toHaveLength(4);
  });

  it("is a no-op with no breaks or a break before the first row", () => {
    expect(insertBreakSpacers(rows, [], "t", ["v"])).toBe(rows);
    expect(insertBreakSpacers(rows, [day("2026-09-01")], "t", ["v"])).toHaveLength(4);
  });
});

describe("breakNotesByRow", () => {
  it("maps the first row at/after the break to its description", () => {
    const rowTimes = [day("2026-10-01"), day("2026-10-03")];
    const notes = breakNotesByRow(rowTimes, [{ t: day("2026-10-02"), label: "l", description: "d" }]);
    expect(notes.get(day("2026-10-03"))).toBe("d");
  });
});

describe("computeBreakAwareDomain", () => {
  const points = [
    ...[0, 1, 2].map((i) => ({ t: i, v: 95_900 + i })),
    ...[5, 6, 7, 8, 9, 10].map((i) => ({ t: i, v: 102_000 + (i % 2) * 100 })),
  ];

  it("excludes a short pre-break stretch that would flatten the current trend", () => {
    const [lo, hi] = computeBreakAwareDomain(points, ["v"], [5], "t") as [number, number];
    expect(lo).toBeGreaterThan(101_000);
    expect(hi).toBeLessThan(103_000);
  });

  it("judges each series on its own, so a second line cannot hide the jump", () => {
    const rows = [
      { t: 0, a: 52, b: 43 },
      { t: 5, a: 38.5, b: 43 },
      { t: 6, a: 38.6, b: 46 },
      { t: 7, a: 40, b: 46.5 },
    ];
    const [lo, hi] = computeBreakAwareDomain(rows, ["a", "b"], [5], "t") as [number, number];
    expect(lo).toBeGreaterThan(30);
    expect(hi).toBeLessThan(52);
    expect(lo).toBeLessThan(38.5);
    expect(hi).toBeGreaterThan(46.5);
  });

  it("keeps a long pre-break history on the plot", () => {
    const long = [...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ t: i, v: 97_000 + i })), ...[10, 11, 12].map((i) => ({ t: i, v: 102_000 + i }))];
    const [lo] = computeBreakAwareDomain(long, ["v"], [10], "t") as [number, number];
    expect(lo).toBeLessThan(97_000);
  });

  it("keeps older segments when the break is small relative to the trend", () => {
    const small = [
      { t: 0, v: 100 }, { t: 1, v: 110 }, { t: 2, v: 90 },
      { t: 3, v: 105 }, { t: 4, v: 95 }, { t: 5, v: 108 },
    ];
    const [lo, hi] = computeBreakAwareDomain(small, ["v"], [3], "t") as [number, number];
    expect(lo).toBeLessThan(91);
    expect(hi).toBeGreaterThan(109);
  });

  it("matches computeSeriesDomain when no breaks are declared", () => {
    expect(computeBreakAwareDomain(points, ["v"], [], "t")).toEqual(computeSeriesDomain(points, ["v"]));
  });
});

describe("limitedHistoryCount", () => {
  it("flags 1-4 measured rows, not 0 or 5+", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i, v: i }));
    expect(limitedHistoryCount(rows(0), ["v"])).toBeNull();
    expect(limitedHistoryCount(rows(4), ["v"])).toBe(4);
    expect(limitedHistoryCount(rows(MIN_SMOOTH_POINTS), ["v"])).toBeNull();
  });

  it("ignores null-valued spacer rows", () => {
    expect(limitedHistoryCount([{ v: 1 }, { v: null }, { v: 2 }], ["v"])).toBe(2);
  });
});

describe("committed feeds", () => {
  const load = (p: string) => JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8")) as ClassificationChangelog;

  it("declare the known breaks and keep undeclared events untouched", () => {
    const tel = load("public/data/classification-changelog.json");
    const telBreaks = getSeriesBreaks(tel, ["retail.balance", "holderCount"], day("2026-09-01"));
    expect(telBreaks.map((b) => b.t)).toEqual([day("2026-09-29"), day("2026-10-03")]);
    const zbcn = load("public/data/zebec-network/classification-changelog.json");
    expect(getSeriesBreaks(zbcn, ["retail.balance"], day("2026-10-01")).map((b) => b.t)).toEqual([day("2026-10-26"), day("2026-10-28")]);
    expect(getSeriesBreaks(zbcn, ["retail.count"], day("2026-10-01")).map((b) => b.t)).toEqual([day("2026-10-28")]);
    expect(getSeriesBreaks(zbcn, ["cexBalance"], day("2026-10-01")).map((b) => b.t)).toEqual([day("2026-10-28")]);
    expect(tel.events.filter((e) => !e.breaksSeries).length).toBeGreaterThan(10);
  });
});

describe("breakTooltip", () => {
  const b = { t: Date.UTC(2026, 9, 3), label: "Methodology change", description: "d" };
  it("reads 'Method change · date' and appends the event summary when there is one", () => {
    expect(breakTooltip(b)).toBe("Method change · Oct 3, 2026");
    expect(breakTooltip({ ...b, summary: "Wallets reclassified" })).toBe("Method change · Oct 3, 2026 · Wallets reclassified");
  });
  it("shortens a long summary", () => {
    const out = breakTooltip({ ...b, summary: "word ".repeat(60) });
    expect(out.length).toBeLessThanOrEqual(BREAK_SUMMARY_MAX + "Method change · Oct 3, 2026 · ".length);
    expect(out.endsWith("…")).toBe(true);
  });
  it("carries the changelog event summary through getSeriesBreaks", () => {
    const out = getSeriesBreaks(feed(event({ summary: "Moved wallets", breaksSeries: { metrics: ["retail.balance"] } })), ["retail.balance"], day("2026-10-01"));
    expect(out[0].summary).toBe("Moved wallets");
  });
});
