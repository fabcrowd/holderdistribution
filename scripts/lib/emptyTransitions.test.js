import { describe, it, expect } from "vitest";
import { emptyTransitions } from "./emptyTransitions.js";

describe("emptyTransitions", () => {
  it("is a valid transitions feed with no ranges, stamped with the given time", () => {
    const now = new Date("2026-11-05T03:00:00.000Z");
    expect(emptyTransitions(now)).toEqual({ generatedAt: "2026-11-05T03:00:00.000Z", ranges: {} });
  });

  it("has no latestDate, because no snapshot date exists to name", () => {
    expect(emptyTransitions(new Date()).latestDate).toBeUndefined();
  });
});
