import { describe, it, expect } from "vitest";
import { baseSnapshotIndex } from "./transitionBase.js";

// Snapshot dates in commit order. A settled day's snapshot is committed the next day, so the
// index a window asks for can hold a snapshot dated one day earlier than the window's start.
const dates = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
const pick = (startIndex, earliest, list = dates) => {
  const read = [];
  const index = baseSnapshotIndex({
    startIndex,
    count: list.length,
    earliest,
    snapshotDateAt: (i) => { read.push(i); return list[i]; },
  });
  return { index, read };
};

describe("baseSnapshotIndex", () => {
  it("keeps the requested snapshot when history starts on or before it", () => {
    expect(pick(1, "2024-01-17").index).toBe(1);
    expect(pick(2, "2026-11-13").index).toBe(2);
  });

  it("keeps the requested snapshot when the project has no history yet", () => {
    expect(pick(0, null)).toEqual({ index: 0, read: [] });
  });

  it("steps forward to the first snapshot dated on or after the first history row", () => {
    expect(pick(0, "2026-11-14").index).toBe(3);
    expect(pick(2, "2026-11-14").index).toBe(3);
  });

  it("reads only the snapshots it has to", () => {
    expect(pick(2, "2026-11-14").read).toEqual([2, 3]);
    expect(pick(3, "2026-11-14").read).toEqual([3]);
  });

  it("stops at the newest snapshot when none is late enough", () => {
    expect(pick(0, "2026-12-01").index).toBe(dates.length - 1);
  });

  it("handles a single snapshot", () => {
    expect(pick(0, "2026-11-14", ["2026-11-13"]).index).toBe(0);
  });
});
