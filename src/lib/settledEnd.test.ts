import { describe, expect, it } from "vitest";
import { DAY_MS, pickWindowBaseline, settledEndMs, windowBounds, walletSetChangesFor, ytdDaysEndingAt } from "./settledEnd";
import { ytdDays } from "./timeRange";

const NOW = new Date("2026-11-06T15:30:00Z");
const TODAY = Date.parse("2026-11-06");

describe("settledEndMs", () => {
  it("uses asOf.date + 1 day (exclusive end; asOf is the last settled day)", () => {
    expect(settledEndMs({ asOf: { date: "2026-11-03" } }, NOW)).toBe(Date.parse("2026-11-04"));
  });
  it("falls back to today 00:00 UTC", () => {
    expect(settledEndMs({}, NOW)).toBe(TODAY);
    expect(settledEndMs(null, NOW)).toBe(TODAY);
  });
  it("ignores an unparseable asOf", () => {
    expect(settledEndMs({ asOf: { date: "bad" } }, NOW)).toBe(TODAY);
  });
  it("settled:false excludes the in-progress asOf day (end = asOf.date 00:00Z)", () => {
    expect(settledEndMs({ asOf: { date: "2026-11-06", settled: false } }, NOW)).toBe(TODAY);
    expect(settledEndMs({ asOf: { date: "2026-11-05", settled: true } }, NOW)).toBe(TODAY);
  });
  it("settled:false with no date ends after the last available row, else today", () => {
    const unsettled = { asOf: { date: null, settled: false } };
    expect(settledEndMs(unsettled, NOW, Date.parse("2026-11-02"))).toBe(Date.parse("2026-11-03"));
    expect(settledEndMs(unsettled, NOW, Date.parse("2026-11-02T23:59:59Z"))).toBe(Date.parse("2026-11-03"));
    expect(settledEndMs(unsettled, NOW)).toBe(TODAY);
    expect(settledEndMs(unsettled, NOW, null)).toBe(TODAY);
    expect(settledEndMs(unsettled, NOW, NaN)).toBe(TODAY);
    expect(settledEndMs(unsettled, NOW, Date.parse("2026-11-06"))).toBe(TODAY); // never past today
    expect(settledEndMs({}, NOW, Date.parse("2026-11-02"))).toBe(TODAY); // no asOf: unchanged
  });
});

describe("ytdDaysEndingAt", () => {
  it("counts Jan 1 .. D inclusive for exclusive end D + 1", () => {
    expect(ytdDaysEndingAt(Date.parse("2026-11-06"))).toBe(309);
    expect(ytdDaysEndingAt(Date.parse("2026-01-02"))).toBe(1);
  });
  it("on Jan 1 (D = Dec 31) covers the whole previous year", () => {
    expect(ytdDaysEndingAt(Date.parse("2026-01-01"))).toBe(365);
  });
});

describe("windowBounds", () => {
  it("returns [end - days, end)", () => {
    expect(windowBounds(TODAY, 7)).toEqual([TODAY - 7 * DAY_MS, TODAY]);
  });
  it("treats days < 1 as 1", () => {
    expect(windowBounds(TODAY, 0)).toEqual([TODAY - DAY_MS, TODAY]);
  });
});

describe("pickWindowBaseline", () => {
  const pts = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-05", "2026-11-06"].map((date) => ({ date }));
  const ts = (p: { date: string }) => Date.parse(p.date);

  const END_1107 = Date.parse("2026-11-07"); // asOf 2026-11-06

  it("end = last row before the exclusive end, start = row dated end - (N + 1) days", () => {
    const r = pickWindowBaseline(pts, END_1107, 7, ts);
    expect(r?.start.date).toBe("2026-10-30");
    expect(r?.end.date).toBe("2026-11-06");
    expect(r?.approximate).toBe(false);
  });
  it("falls back to the tolerant pick and flags it approximate", () => {
    const r = pickWindowBaseline(pts, END_1107, 10, ts); // target 10-27, nearest 10-28
    expect(r?.start.date).toBe("2026-10-28");
    expect(r?.approximate).toBe(true);
  });
  it("excludes the row dated at the exclusive end (partial day)", () => {
    const r = pickWindowBaseline(pts, TODAY, 6, ts);
    expect(r?.end.date).toBe("2026-11-05");
    expect(r?.start.date).toBe("2026-10-30");
    expect(r?.approximate).toBe(false);
  });
  it("asOf 2026-11-05, 1 day: end is the 11-05 row", () => {
    const dense = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((date) => ({ date }));
    const r = pickWindowBaseline(dense, settledEndMs({ asOf: { date: "2026-11-05" } }, NOW), 1, ts);
    expect(r?.end.date).toBe("2026-11-05");
    expect(r?.start.date).toBe("2026-11-04");
    expect(r?.approximate).toBe(false);
  });
  it("returns null when nothing is in tolerance or no end point exists", () => {
    expect(pickWindowBaseline(pts, END_1107, 1, ts)?.start.date).toBe("2026-11-05");
    expect(pickWindowBaseline(pts, Date.parse("2026-10-01"), 7, ts)).toBeNull();
    expect(pickWindowBaseline([], END_1107, 7, ts)).toBeNull();
    expect(pickWindowBaseline(pts, END_1107, 60, ts)).toBeNull();
  });
  it("flags approximate when the settled day D row is missing (does not silently end at D-1)", () => {
    const noD = ["2026-10-29", "2026-10-30", "2026-11-04"].map((date) => ({ date }));
    const r = pickWindowBaseline(noD, Date.parse("2026-11-06"), 6, ts); // D = 11-05 missing
    expect(r?.end.date).toBe("2026-11-04");
    expect(r?.approximate).toBe(true);
  });
  it("YTD on 2026-11-06 (D = 11-05): start is the Dec 31 row", () => {
    const now = new Date("2026-11-06T15:30:00Z");
    const daily = ["2025-12-30", "2025-12-31", "2026-01-01", "2026-11-04", "2026-11-05"].map((date) => ({ date }));
    const r = pickWindowBaseline(daily, Date.parse("2026-11-06"), ytdDays(now), ts, now);
    expect(r?.start.date).toBe("2025-12-31");
    expect(r?.end.date).toBe("2026-11-05");
    expect(r?.approximate).toBe(false);
  });
  it("YTD on Jan 1 (D = Dec 31): start is the previous Dec 31 row", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const daily = ["2024-12-31", "2025-06-01", "2025-12-31"].map((date) => ({ date }));
    const r = pickWindowBaseline(daily, Date.parse("2026-01-01"), ytdDays(now), ts, now);
    expect(r?.start.date).toBe("2024-12-31");
    expect(r?.end.date).toBe("2025-12-31");
    expect(r?.approximate).toBe(false);
  });
});

describe("walletSetChangesFor", () => {
  const ev = (id: string, date: string, summary: string, backfillStatus = "partial") => ({
    id,
    date,
    type: "exclusion-add" as const,
    summary,
    affects: { artifacts: [], metrics: ["cexBalance"] },
    backfillStatus: backfillStatus as "partial",
  });
  const changelog = {
    schemaVersion: 1,
    generatedAt: "",
    events: [ev("a", "2026-11-02", "Added Kraken hot wallets"), ev("b", "2026-11-03", "Relabel KuCoin vault"), ev("c", "2026-09-01", "Kraken old")],
  };
  it("returns events inside the window that name the exchange", () => {
    const r = walletSetChangesFor(changelog, "Kraken", TODAY - 7 * DAY_MS, TODAY);
    expect(r.map((e) => e.id)).toEqual(["a"]);
  });
  it("does not match a different exchange or substring of a word", () => {
    expect(walletSetChangesFor(changelog, "OKX", TODAY - 7 * DAY_MS, TODAY)).toEqual([]);
  });

  // Real shape from public/data/classification-changelog.json (backfillStatus "complete").
  const kraken = {
    id: "2026-07-22-cex-hot-wallets-add-22",
    date: "2026-07-22",
    type: "exclusion-add" as const,
    summary: "Added 22 missing CEX hot wallets to cexSet (Kraken 1.47B TEL, Uphold 17.3M TEL)",
    affects: {
      artifacts: ["cex-balance-history", "exchange-flow-history", "tier-outflows", "holder-transitions", "holders-history"],
      metrics: ["cexBalance", "retail.count", "cumulativeHolders"],
    },
    backfillStatus: "complete" as const,
  };
  const real = { schemaVersion: 1, generatedAt: "", events: [kraken] };
  const from = Date.parse("2026-07-01"), to = Date.parse("2026-08-01");
  it("flags a backfilled Kraken event inside the window", () => {
    expect(walletSetChangesFor(real, "Kraken", from, to).map((e) => e.id)).toEqual([kraken.id]);
    expect(walletSetChangesFor(real, "Uphold", from, to)).toHaveLength(1);
  });
  it("skips it outside the window, for other exchanges, or without cexBalance", () => {
    expect(walletSetChangesFor(real, "Kraken", to, to + 30 * DAY_MS)).toEqual([]);
    expect(walletSetChangesFor(real, "Binance", from, to)).toEqual([]);
    const noCex = { ...real, events: [{ ...kraken, affects: { artifacts: [], metrics: ["retail.count"] } }] };
    expect(walletSetChangesFor(noCex, "Kraken", from, to)).toEqual([]);
  });
});
