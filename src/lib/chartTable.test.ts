import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_MAX_ROWS, defaultTableTitle, formatCell, limitTableRows, rowsWithValues, tableNote, tableTitleFor } from "./chartTable";

const days = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i }));

describe("limitTableRows", () => {
  it("keeps the newest rows and reports the full count", () => {
    const out = limitTableRows(days(10), 3);
    expect(out.total).toBe(10);
    expect(out.rows.map((r) => r.t)).toEqual([7, 8, 9]);
  });

  it("keeps chronological order inside the window", () => {
    const out = limitTableRows(days(100), 60);
    const ts = out.rows.map((r) => r.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts[0]).toBe(40);
    expect(ts[ts.length - 1]).toBe(99);
  });

  it("returns every row when the count equals the limit exactly", () => {
    const out = limitTableRows(days(DEFAULT_TABLE_MAX_ROWS), DEFAULT_TABLE_MAX_ROWS);
    expect(out.rows).toHaveLength(DEFAULT_TABLE_MAX_ROWS);
    expect(out.rows[0].t).toBe(0);
  });

  it("returns every row under the limit", () => {
    expect(limitTableRows(days(4), 60).rows).toHaveLength(4);
  });

  it("returns no rows for an empty input", () => {
    expect(limitTableRows([], 60)).toEqual({ rows: [], total: 0 });
  });

  it("returns no rows for a zero limit", () => {
    expect(limitTableRows(days(5), 0).rows).toEqual([]);
  });
});

describe("tableNote", () => {
  it("states how many rows are shown of the total when rows were cut", () => {
    expect(tableNote(60, 137)).toBe("Showing the latest 60 of 137 rows.");
  });

  it("is absent when every row is shown", () => {
    expect(tableNote(12, 12)).toBeNull();
  });
});

describe("rowsWithValues", () => {
  it("drops rows where every value column is null or undefined", () => {
    const rows = [
      { t: 1, a: 5, b: null },
      { t: 2, a: null, b: null },
      { t: 3, a: undefined, b: 7 },
      { t: 4, a: null },
    ];
    expect(rowsWithValues(rows, ["a", "b"]).map((r) => r.t)).toEqual([1, 3]);
  });

  it("keeps a row where one column is still measured", () => {
    expect(rowsWithValues([{ t: 1, a: null, b: 0 }], ["a", "b"])).toHaveLength(1);
  });

  it("treats zero as a value", () => {
    expect(rowsWithValues([{ t: 1, a: 0 }], ["a"])).toHaveLength(1);
  });
});

describe("formatCell", () => {
  it("shows a dash for a missing value", () => {
    expect(formatCell(null)).toBe("—");
    expect(formatCell(undefined, (v) => `${v}`)).toBe("—");
  });

  it("applies the column formatter to a present value", () => {
    expect(formatCell(1234, (v) => `#${v}`)).toBe("#1234");
  });

  it("falls back to the string value without a formatter", () => {
    expect(formatCell("Treasury")).toBe("Treasury");
  });
});

describe("tableTitleFor", () => {
  it("uses the short title when given", () => {
    expect(tableTitleFor("Long summary sentence.", "Wallets by date")).toBe("Wallets by date");
  });

  it("falls back to the caption without a title, or with a blank one", () => {
    expect(tableTitleFor("Caption.")).toBe("Caption.");
    expect(tableTitleFor("Caption.", "   ")).toBe("Caption.");
  });
});

describe("defaultTableTitle", () => {
  it("names one series", () => {
    expect(defaultTableTitle(["Wallets"])).toBe("Wallets by date");
  });

  it("joins several series and appends a noun", () => {
    expect(defaultTableTitle(["Retail", "Exchanges"], "balances")).toBe("Retail and Exchanges balances by date");
  });
});
