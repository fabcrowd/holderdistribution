import { describe, expect, it } from "vitest";
import { historyStartsAfterRange } from "./historyStart";

const DAY = 86_400_000;
const now = Date.parse("2026-10-29T00:00:00Z");

describe("historyStartsAfterRange", () => {
  it("returns the first timestamp when the data starts well after the range start", () => {
    const first = Date.parse("2026-10-25T00:00:00Z");
    expect(historyStartsAfterRange(first, 90, now)).toBe(first);
  });

  it("returns null when the data covers the range (within the slack)", () => {
    expect(historyStartsAfterRange(now - 89 * DAY, 90, now)).toBeNull();
    expect(historyStartsAfterRange(now - 400 * DAY, 90, now)).toBeNull();
  });

  it("returns null for missing input", () => {
    expect(historyStartsAfterRange(undefined, 90, now)).toBeNull();
    expect(historyStartsAfterRange(now, 0, now)).toBeNull();
  });
});
