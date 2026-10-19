import { describe, expect, it } from "vitest";
import { assertHolderLiteSnapshot } from "./useHolderSnapshot";

describe("assertHolderLiteSnapshot", () => {
  it("accepts a snapshot that has a combined view", () => {
    const snap = { views: { combined: { metrics: {} } }, overlap: null };
    expect(assertHolderLiteSnapshot(snap)).toBe(snap);
  });

  it.each([null, undefined, 42, "html", {}, { views: {} }, { views: { combined: null } }, { views: [] }])(
    "rejects malformed payload %j instead of letting the page crash",
    (payload) => {
      expect(() => assertHolderLiteSnapshot(payload)).toThrow(/malformed/);
    },
  );
});
