import { describe, expect, it } from "vitest";
import { nextUsage, validateUsage } from "./usage.js";
import { RecordShapeError } from "./errors.js";

describe("usage totals (design 8.1)", () => {
  it("a first publish counts its own run in the day and the month", () => {
    expect(nextUsage({ parent: null, day: "2026-11-18", used: { a: 5, b: 1 } })).toEqual({
      day: "2026-11-18", month: "2026-11", run: { a: 5, b: 1 }, dayTotal: { a: 5, b: 1 }, monthTotal: { a: 5, b: 1 },
    });
  });

  it("a second publish the same day adds its own run once, to the parent's totals", () => {
    const one = nextUsage({ parent: null, day: "2026-11-18", used: { a: 5 } });
    const two = nextUsage({ parent: one, day: "2026-11-18", used: { a: 3, b: 2 } });
    expect(two.run).toEqual({ a: 3, b: 2 });
    expect(two.dayTotal).toEqual({ a: 8, b: 2 });
    expect(two.monthTotal).toEqual({ a: 8, b: 2 });
    const three = nextUsage({ parent: two, day: "2026-11-18", used: { a: 1 } });
    expect(three.dayTotal).toEqual({ a: 9, b: 2 }); // the first run is not counted again
  });

  it("a new day resets the day total and keeps the month's", () => {
    const one = nextUsage({ parent: null, day: "2026-11-18", used: { a: 5 } });
    const next = nextUsage({ parent: one, day: "2026-11-19", used: { a: 2 } });
    expect(next.dayTotal).toEqual({ a: 2 });
    expect(next.monthTotal).toEqual({ a: 7 });
  });

  it("a new month resets both totals", () => {
    const one = nextUsage({ parent: null, day: "2026-11-30", used: { a: 5 } });
    const next = nextUsage({ parent: one, day: "2026-12-01", used: { a: 2 } });
    expect(next.dayTotal).toEqual({ a: 2 });
    expect(next.monthTotal).toEqual({ a: 2 });
    expect(next.month).toBe("2026-12");
  });

  it("does not mutate the parent or the run's use", () => {
    const parent = nextUsage({ parent: null, day: "2026-11-18", used: { a: 5 } });
    const used = { a: 1 };
    const pf = JSON.stringify(parent);
    nextUsage({ parent, day: "2026-11-18", used });
    expect(JSON.stringify(parent)).toBe(pf);
    expect(used).toEqual({ a: 1 });
  });

  it("a __proto__, constructor or prototype provider key is refused, so no use is dropped (review M1)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => nextUsage({ parent: null, day: "2026-11-18", used: JSON.parse(`{"${key}": 5, "b": 1}`) })).toThrow(RecordShapeError);
    }
    const ok = nextUsage({ parent: null, day: "2026-11-18", used: { toString: 2 } });
    expect(Object.hasOwn(ok.dayTotal, "toString")).toBe(true);
    expect(ok.dayTotal.toString).toBe(2);
  });

  it("refuses a bad use or day", () => {
    expect(() => nextUsage({ parent: null, day: "2026-11-18", used: { a: -1 } })).toThrow(RecordShapeError);
    expect(() => nextUsage({ parent: null, day: "2026-11-18", used: { a: 1.5 } })).toThrow(RecordShapeError);
    expect(() => nextUsage({ parent: null, day: "nope", used: {} })).toThrow(RecordShapeError);
    expect(() => validateUsage({ day: "2026-11-18" }, "bundle example/holders", "usage")).toThrow(RecordShapeError);
  });
});
