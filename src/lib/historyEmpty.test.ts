import { describe, expect, it } from "vitest";
import { emptyHistoryMessage } from "./historyEmpty";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;

describe("emptyHistoryMessage", () => {
  it("says no history yet when the series has no points at all", () => {
    expect(emptyHistoryMessage(0, undefined, 30, NOW)).toBe("No history recorded yet.");
  });

  it("says one snapshot, without a start date, when history covers the range", () => {
    expect(emptyHistoryMessage(1, NOW - 40 * DAY, 30, NOW)).toBe("History is still building: 1 snapshot in this range.");
  });

  it("adds the start date when a longer range predates history", () => {
    const first = Date.parse("2026-11-04T00:00:00Z");
    expect(emptyHistoryMessage(1, first, 90, NOW)).toBe(
      "History is still building: 1 snapshot in this range. History tracked from Nov 4, 2026.",
    );
  });

  it("explains zero in-range points when the series exists", () => {
    const first = Date.parse("2025-10-27T00:00:00Z");
    expect(emptyHistoryMessage(0, first, 30, NOW)).toBe("No snapshots in this range. History tracked from Oct 27, 2025.");
  });
});
