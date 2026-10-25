import { describe, expect, it } from "vitest";
import { dataUrl, resolveDataUrl } from "./dataUrl";

describe("dataUrl(slug, file)", () => {
  it("uses the live-data function path in production", () => {
    expect(dataUrl("tel", "holders-lite.json", { base: "/", live: true })).toBe("/live-data/tel/holders-lite.json");
  });
  it("uses the static /data/<slug>/ path when live data is off", () => {
    expect(dataUrl("tel", "holders-lite.json", { base: "/", live: false })).toBe("/data/tel/holders-lite.json");
    expect(dataUrl("abc", "tier-outflows.json", { base: "/", live: false })).toBe("/data/abc/tier-outflows.json");
  });
  it("normalizes a base without a trailing (or leading) slash", () => {
    expect(dataUrl("tel", "x.json", { base: "/sub", live: true })).toBe("/sub/live-data/tel/x.json");
    expect(dataUrl("tel", "x.json", { base: "sub", live: false })).toBe("/sub/data/tel/x.json");
  });
  it("defaults to the static path under vitest/dev (no functions there)", () => {
    expect(dataUrl("tel", "x.json")).toBe("/data/tel/x.json");
  });
});

describe("resolveDataUrl (pre-multi-token helper)", () => {
  it("resolves to the default project", () => {
    expect(resolveDataUrl("holders-lite.json", { base: "/", live: true })).toBe("/live-data/tel/holders-lite.json");
    expect(resolveDataUrl("x.json")).toBe("/data/tel/x.json");
  });
});
