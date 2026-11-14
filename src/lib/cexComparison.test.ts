import { describe, expect, it } from "vitest";
import { cexFlowsFallbackUsable } from "./cexComparison";

describe("cexFlowsFallbackUsable", () => {
  it("keeps today's behavior when the feed has no comparison key", () => {
    expect(cexFlowsFallbackUsable(undefined, 1)).toBe(true);
    expect(cexFlowsFallbackUsable(null, 30)).toBe(true);
  });
  it("is never usable when the comparison is unavailable", () => {
    expect(cexFlowsFallbackUsable({ available: false, reason: "no prior snapshot" }, 1)).toBe(false);
    expect(cexFlowsFallbackUsable({ available: false }, 30)).toBe(false);
  });
  it("is usable only for a one-day range when the comparison is available", () => {
    expect(cexFlowsFallbackUsable({ available: true, windowDays: 1 }, 1)).toBe(true);
    expect(cexFlowsFallbackUsable({ available: true, windowDays: 1 }, 7)).toBe(false);
    expect(cexFlowsFallbackUsable({ available: true, windowDays: 1 }, 365)).toBe(false);
  });
});
