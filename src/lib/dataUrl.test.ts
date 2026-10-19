import { describe, it, expect } from "vitest";
import { resolveDataUrl } from "./dataUrl";

describe("resolveDataUrl", () => {
  it("uses the live-data function path in production", () => {
    expect(resolveDataUrl("holders-lite.json", { base: "/", live: true })).toBe("/live-data/holders-lite.json");
  });
  it("uses the static /data/ path when live data is off", () => {
    expect(resolveDataUrl("holders-lite.json", { base: "/", live: false })).toBe("/data/holders-lite.json");
  });
  it("normalizes a base without a trailing slash", () => {
    expect(resolveDataUrl("x.json", { base: "/sub", live: true })).toBe("/sub/live-data/x.json");
  });
  it("defaults to the static path under vitest/dev (no functions there)", () => {
    expect(resolveDataUrl("x.json")).toBe("/data/x.json");
  });
});
