import { describe, it, expect } from "vitest";
import { emptyTransitions } from "./emptyTransitions.js";

describe("emptyTransitions", () => {
  it("is a valid transitions feed with no ranges, stamped with the given time", () => {
    const now = new Date("2026-11-05T03:00:00.000Z");
    expect(emptyTransitions(now)).toEqual({ generatedAt: "2026-11-05T03:00:00.000Z", ranges: {} });
  });

  it("carries the snapshot's asOf when given, so a first run's feeds align on one day", () => {
    const asOf = { date: "2026-11-10", blocks: { hedera: 102188882 }, settled: true };
    expect(emptyTransitions(new Date("2026-11-11T05:00:00.000Z"), asOf)).toEqual({ generatedAt: "2026-11-11T05:00:00.000Z", asOf, ranges: {} });
  });

  it("has no latestDate, because no snapshot date exists to name", () => {
    expect(emptyTransitions(new Date()).latestDate).toBeUndefined();
  });
});
