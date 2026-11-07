import { describe, expect, it } from "vitest";
import { endOfDayLabel, previousDay, relabelMidnightEntries } from "./relabel-midnight-history.js";

const mid = (date, extra = {}) => ({ date, generatedAt: `${date}T00:00:00.000Z`, v: date, ...extra });

describe("relabelMidnightEntries", () => {
  it("moves midnight rows to D-1 at 23:59:59", () => {
    const { entries, relabelled } = relabelMidnightEntries([mid("2026-03-01"), mid("2026-03-02")]);
    expect(relabelled).toBe(2);
    expect(entries).toEqual([
      { date: "2026-02-28", generatedAt: "2026-02-28T23:59:59.000Z", v: "2026-03-01" },
      { date: "2026-03-01", generatedAt: "2026-03-01T23:59:59.000Z", v: "2026-03-02" },
    ]);
  });

  it("leaves non-midnight and marked rows alone", () => {
    const live = { date: "2026-03-03", generatedAt: "2026-03-03T05:14:55.691Z" };
    const settled = mid("2026-03-05", { settled: true });
    const asOf = mid("2026-03-06", { asOf: { date: "2026-03-05" } });
    const { entries, relabelled } = relabelMidnightEntries([live, settled, asOf]);
    expect(relabelled).toBe(0);
    expect(entries).toEqual([live, settled, asOf]);
  });

  it("keeps the existing row on collision and reports it", () => {
    const existing = { date: "2026-03-01", generatedAt: "2026-03-01T23:59:59.000Z", settled: true };
    const { entries, collisions } = relabelMidnightEntries([existing, mid("2026-03-02")]);
    expect(entries).toEqual([existing]);
    expect(collisions).toEqual([{ from: "2026-03-02", to: "2026-03-01" }]);
  });

  it("is idempotent and does not mutate input", () => {
    const input = [mid("2026-01-01"), mid("2026-01-02")];
    const copy = structuredClone(input);
    const once = relabelMidnightEntries(input).entries;
    expect(input).toEqual(copy);
    const twice = relabelMidnightEntries(once);
    expect(twice.relabelled).toBe(0);
    expect(twice.entries).toEqual(once);
  });

  it("handles empty input and year boundaries", () => {
    expect(relabelMidnightEntries(undefined).entries).toEqual([]);
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
    expect(endOfDayLabel("2024-03-01")).toEqual({ date: "2024-02-29", generatedAt: "2024-02-29T23:59:59.000Z" });
  });
});
